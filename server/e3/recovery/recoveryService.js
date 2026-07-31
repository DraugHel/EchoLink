import { randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync
} from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  E3_LEASE_RESOURCE_TYPE,
  E3_SESSION_STATUS,
  assertCanonicalSessionId,
  assertFencingToken,
  assertSafeToken,
  assertTimestamp,
  freezeDomainValue,
  isCanonicalSessionId
} from '../core/contracts.js'
import { acquireManagerLock } from '../workspaces/managerLock.js'
import {
  E3_WORKSPACE_MANIFEST_VERSION,
  E3_WORKSPACE_STATE
} from '../workspaces/contracts.js'
import {
  readVerifiedWorkspaceManifest
} from '../workspaces/workspaceManifest.js'
import {
  E3_RECOVERY_DECISION,
  E3_RECOVERY_POLICY,
  E3_RECOVERY_POLICY_SHA256,
  E3_RECOVERY_POLICY_VERSION,
  E3_RECOVERY_REASON,
  E3_RECOVERY_REQUEST_FIELDS,
  E3_RECOVERY_RESOURCE_TYPE,
  canonicalRecoveryJson,
  recoverySha256
} from './contracts.js'
import {
  E3_RECOVERY_ERROR,
  E3RecoveryError
} from './errors.js'
import { RecoveryRepository } from './recoveryRepository.js'

const CLEANUP_STATUSES = new Set([
  E3_SESSION_STATUS.EXPORTED,
  E3_SESSION_STATUS.COMPLETED,
  E3_SESSION_STATUS.FAILED,
  E3_SESSION_STATUS.CANCELLED,
  E3_SESSION_STATUS.STALE,
  E3_SESSION_STATUS.CONFLICTED
])

function recoveryError(code, message, details = {}, cause) {
  throw new E3RecoveryError(
    code,
    message,
    details,
    cause ? { cause } : {}
  )
}

function exactFields(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    recoveryError(
      E3_RECOVERY_ERROR.INVALID_REQUEST,
      'Recovery request must be an object'
    )
  }
  const actual = Object.keys(value).sort()
  const fields = [...expected].sort()
  if (
    actual.length !== fields.length ||
    actual.some((field, index) => field !== fields[index])
  ) {
    recoveryError(
      E3_RECOVERY_ERROR.INVALID_REQUEST,
      'Recovery request fields do not match the V1 contract'
    )
  }
}

function validateRequest(input) {
  exactFields(input, E3_RECOVERY_REQUEST_FIELDS)
  try {
    assertCanonicalSessionId(input.runId)
    assertSafeToken(input.actorId, 'actorId')
    assertSafeToken(input.requestId, 'requestId', {
      minLength: 8,
      maxLength: 160
    })
    assertTimestamp(input.occurredAt, 'occurredAt')
    assertSafeToken(input.cleanupLeaseOwner, 'cleanupLeaseOwner')
    assertFencingToken(
      input.cleanupFencingToken,
      'cleanupFencingToken'
    )
  } catch (cause) {
    recoveryError(
      E3_RECOVERY_ERROR.INVALID_REQUEST,
      'Recovery request envelope is invalid',
      {},
      cause
    )
  }
  if (
    !Number.isSafeInteger(input.leaseDurationMs) ||
    input.leaseDurationMs < E3_RECOVERY_POLICY.leaseDurationMinMs ||
    input.leaseDurationMs > E3_RECOVERY_POLICY.leaseDurationMaxMs
  ) {
    recoveryError(
      E3_RECOVERY_ERROR.INVALID_REQUEST,
      'Recovery leaseDurationMs is outside policy'
    )
  }
}

function pathsOverlap(first, second) {
  const left = resolve(first)
  const right = resolve(second)
  const leftToRight = relative(left, right)
  const rightToLeft = relative(right, left)
  return (
    left === right ||
    (leftToRight !== '..' && !leftToRight.startsWith(`..${sep}`)) ||
    (rightToLeft !== '..' && !rightToLeft.startsWith(`..${sep}`))
  )
}

function assertRealDirectory(path, code, label) {
  let metadata
  try {
    metadata = lstatSync(path)
  } catch (cause) {
    recoveryError(code, `${label} does not exist`, {}, cause)
  }
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    realpathSync(path) !== resolve(path)
  ) {
    recoveryError(code, `${label} is not a canonical real directory`)
  }
  return path
}

function leaseIsValid(lease, occurredAt) {
  return Boolean(lease && lease.expiresAt > occurredAt)
}

function expectedPaths(storageRoot, sessionId) {
  const workspacesPath = join(storageRoot, 'workspaces')
  const workspaceRoot = join(workspacesPath, sessionId)
  return Object.freeze({
    workspacesPath,
    workspaceRoot,
    treePath: join(workspaceRoot, 'tree'),
    manifestPath: join(workspaceRoot, 'manifest.json')
  })
}

function validateManifest(manifest, snapshot, paths) {
  const expected = {
    schemaVersion: E3_WORKSPACE_MANIFEST_VERSION,
    sessionId: snapshot.sessionId,
    workspaceKey: snapshot.workspaceKey,
    baseCommit: snapshot.baseCommit,
    treeSha: snapshot.treeSha,
    canonicalWorkspacePath: snapshot.canonicalPath,
    managerOwner: snapshot.managerOwner,
    createdAt: snapshot.createdAt,
    fencingToken: snapshot.fencingToken
  }
  for (const [field, value] of Object.entries(expected)) {
    if (manifest[field] !== value) return false
  }
  return (
    Array.isArray(manifest.expectedSubpaths) &&
    manifest.expectedSubpaths.length === 2 &&
    manifest.expectedSubpaths[0] === 'tree' &&
    manifest.expectedSubpaths[1] === 'manifest.json' &&
    Array.isArray(manifest.allowedRoots) &&
    manifest.allowedRoots.length === 1 &&
    manifest.allowedRoots[0] === paths.treePath
  )
}

function retentionMs(snapshot) {
  if (snapshot.sessionStatus === E3_SESSION_STATUS.EXPORTED) {
    return E3_RECOVERY_POLICY.exportedRetentionMs
  }
  if (snapshot.sessionStatus === E3_SESSION_STATUS.COMPLETED) {
    return E3_RECOVERY_POLICY.completedRetentionMs
  }
  return E3_RECOVERY_POLICY.failedRetentionMs
}

function safeAssociatedArray(value) {
  if (!Array.isArray(value)) return null
  for (const item of value) {
    if (
      !Number.isSafeInteger(item) &&
      !(typeof item === 'string' && item.length >= 1 && item.length <= 160)
    ) {
      return null
    }
  }
  return value
}

function inspectAssociated(items, inspector) {
  let live = false
  for (const item of items) {
    let result
    try {
      result = inspector(item)
    } catch {
      return { live: false, unknown: true }
    }
    if (result !== true && result !== false) {
      return { live: false, unknown: true }
    }
    if (result) live = true
  }
  return { live, unknown: false }
}

function decisionBase(runId, occurredAt, values = {}) {
  return {
    id: randomUUID(),
    runId,
    resourceType: values.resourceType,
    resourceKeySha256: values.resourceKeySha256,
    sessionId: values.sessionId ?? null,
    workspaceKey: values.workspaceKey ?? null,
    initialState: values.initialState ?? null,
    finalState: values.finalState ?? null,
    decision: values.decision,
    reasonCode: values.reasonCode,
    manifestSha256: values.manifestSha256 ?? null,
    sessionFencingToken: values.sessionFencingToken ?? null,
    workspaceFencingToken: values.workspaceFencingToken ?? null,
    logicalSizeBytes: values.logicalSizeBytes ?? 0,
    reclaimedBytes: values.reclaimedBytes ?? 0,
    details: values.details ?? {},
    createdAt: occurredAt
  }
}

export class RecoveryReaperService {
  constructor({
    database,
    repository,
    storageRoot,
    workspaceManager,
    sessionFinalizer,
    enabled = false,
    processInspector = () => null,
    containerInspector = () => null,
    portInspector = () => null,
    faultInjector = () => {},
    now = () => Date.now(),
    forbiddenRoots = [
      '/root/echolink',
      '/root/echolink-backups',
      '/root/echolink-patch-backups'
    ]
  }) {
    if (!repository && !database) {
      recoveryError(
        E3_RECOVERY_ERROR.INVALID_CONFIGURATION,
        'Recovery requires editor.db or a repository adapter'
      )
    }
    if (!workspaceManager?.removeWorkspace) {
      recoveryError(
        E3_RECOVERY_ERROR.INVALID_CONFIGURATION,
        'Recovery requires the trusted WorkspaceManager'
      )
    }
    if (!sessionFinalizer?.completeExportedSession) {
      recoveryError(
        E3_RECOVERY_ERROR.INVALID_CONFIGURATION,
        'Recovery requires an exported-session finalizer'
      )
    }
    if (
      typeof storageRoot !== 'string' ||
      !isAbsolute(storageRoot) ||
      resolve(storageRoot) === '/'
    ) {
      recoveryError(
        E3_RECOVERY_ERROR.INVALID_CONFIGURATION,
        'Recovery storage root must be an absolute non-root path'
      )
    }
    for (const forbiddenRoot of forbiddenRoots) {
      if (
        typeof forbiddenRoot !== 'string' ||
        !isAbsolute(forbiddenRoot)
      ) {
        recoveryError(
          E3_RECOVERY_ERROR.INVALID_CONFIGURATION,
          'Recovery forbidden roots must be absolute'
        )
      }
      if (pathsOverlap(storageRoot, forbiddenRoot)) {
        recoveryError(
          E3_RECOVERY_ERROR.INVALID_CONFIGURATION,
          'Recovery storage overlaps a protected root'
        )
      }
    }
    for (const [name, value] of Object.entries({
      processInspector,
      containerInspector,
      portInspector,
      faultInjector,
      now
    })) {
      if (typeof value !== 'function') {
        recoveryError(
          E3_RECOVERY_ERROR.INVALID_CONFIGURATION,
          `Recovery ${name} must be a function`
        )
      }
    }
    this.repository = repository ?? new RecoveryRepository(database)
    this.storageRoot = resolve(storageRoot)
    this.workspaceManager = workspaceManager
    this.sessionFinalizer = sessionFinalizer
    this.enabled = enabled === true
    this.processInspector = processInspector
    this.containerInspector = containerInspector
    this.portInspector = portInspector
    this.faultInjector = faultInjector
    this.now = now
  }

  run(input) {
    if (!this.enabled) {
      recoveryError(
        E3_RECOVERY_ERROR.FEATURE_DISABLED,
        'E3 recovery is disabled by default'
      )
    }
    validateRequest(input)
    const requestSha256 = recoverySha256(input)
    const replay = this.repository.getRunByRequestId(input.requestId)
    if (replay) {
      if (replay.run.requestSha256 !== requestSha256) {
        recoveryError(
          E3_RECOVERY_ERROR.REQUEST_REPLAY_CONFLICT,
          'Recovery request ID was reused with different bytes'
        )
      }
      return freezeDomainValue({ ...replay, replayed: true })
    }

    const scanAt = this.now()
    try {
      assertTimestamp(scanAt, 'recoveryNow')
    } catch (cause) {
      recoveryError(
        E3_RECOVERY_ERROR.INVALID_CONFIGURATION,
        'Recovery clock returned an invalid timestamp',
        {},
        cause
      )
    }
    if (scanAt < input.occurredAt) {
      recoveryError(
        E3_RECOVERY_ERROR.INVALID_REQUEST,
        'Recovery request timestamp is in the future'
      )
    }
    this.repository.assertCleanupLease({
      owner: input.cleanupLeaseOwner,
      fencingToken: input.cleanupFencingToken,
      occurredAt: scanAt
    })

    const root = assertRealDirectory(
      this.storageRoot,
      E3_RECOVERY_ERROR.STORAGE_ROOT_UNSAFE,
      'Recovery storage root'
    )
    const workspacesPath = assertRealDirectory(
      join(root, 'workspaces'),
      E3_RECOVERY_ERROR.WORKSPACE_INVENTORY_UNSAFE,
      'Workspace inventory root'
    )
    const locksPath = assertRealDirectory(
      join(root, 'locks'),
      E3_RECOVERY_ERROR.WORKSPACE_INVENTORY_UNSAFE,
      'Recovery lock root'
    )
    const lock = acquireManagerLock(
      join(locksPath, 'recovery.lock'),
      {
        owner: input.cleanupLeaseOwner,
        acquiredAt: scanAt
      }
    )

    try {
      this.faultInjector('recovery.after_lock')
      const snapshots = this.repository.listWorkspaceSnapshots()
      const snapshotsById = new Map(
        snapshots.map(snapshot => [snapshot.sessionId, snapshot])
      )
      const inventory = this.#inventory(workspacesPath)
      const plans = []

      for (const entry of inventory) {
        if (!isCanonicalSessionId(entry.name) ||
          !snapshotsById.has(entry.name)) {
          plans.push({
            kind: 'unknown',
            entry,
            decision: E3_RECOVERY_DECISION.QUARANTINE_REQUIRED,
            reasonCode: E3_RECOVERY_REASON.UNKNOWN_DIRECTORY
          })
        }
      }

      for (const snapshot of snapshots) {
        plans.push(this.#classify(
          snapshot,
          scanAt,
          input.cleanupLeaseOwner
        ))
      }

      const decisions = []
      for (const plan of plans) {
        decisions.push(this.#execute(plan, input))
      }
      this.faultInjector('recovery.before_record')
      const completedAt = this.now()
      this.repository.assertCleanupLease({
        owner: input.cleanupLeaseOwner,
        fencingToken: input.cleanupFencingToken,
        occurredAt: completedAt
      })

      const counts = decisions.reduce((result, decision) => {
        result.decisionCount += 1
        result.reclaimedBytes += decision.reclaimedBytes
        if (decision.decision === E3_RECOVERY_DECISION.CLEANED) {
          result.cleanedCount += 1
        } else if (
          decision.decision === E3_RECOVERY_DECISION.FINALIZED
        ) {
          result.finalizedCount += 1
        } else if (
          decision.decision === E3_RECOVERY_DECISION.RETAIN_ACTIVE
        ) {
          result.retainedCount += 1
        } else if (
          decision.decision ===
            E3_RECOVERY_DECISION.QUARANTINE_REQUIRED
        ) {
          result.quarantinedCount += 1
        } else if (
          decision.decision === E3_RECOVERY_DECISION.ALREADY_CLEAN
        ) {
          result.alreadyCleanCount += 1
        }
        return result
      }, {
        decisionCount: 0,
        cleanedCount: 0,
        finalizedCount: 0,
        retainedCount: 0,
        quarantinedCount: 0,
        alreadyCleanCount: 0,
        reclaimedBytes: 0
      })

      const run = {
        id: input.runId,
        policyVersion: E3_RECOVERY_POLICY_VERSION,
        policySha256: E3_RECOVERY_POLICY_SHA256,
        storageRootSha256: recoverySha256(root),
        requestSha256,
        actorId: input.actorId,
        requestId: input.requestId,
        cleanupLeaseOwner: input.cleanupLeaseOwner,
        cleanupFencingToken: input.cleanupFencingToken,
        startedAt: input.occurredAt,
        completedAt,
        ...counts
      }
      const recorded = this.repository.recordRun(run, decisions)
      this.faultInjector('recovery.after_record')
      return recorded
    } finally {
      lock.release()
    }
  }

  #inventory(workspacesPath) {
    let entries
    try {
      entries = readdirSync(workspacesPath, { withFileTypes: true })
    } catch (cause) {
      recoveryError(
        E3_RECOVERY_ERROR.WORKSPACE_INVENTORY_UNSAFE,
        'Workspace inventory could not be read',
        {},
        cause
      )
    }
    return Object.freeze(entries.map(entry => {
      const fullPath = join(workspacesPath, entry.name)
      let metadata
      try {
        metadata = lstatSync(fullPath)
      } catch (cause) {
        recoveryError(
          E3_RECOVERY_ERROR.WORKSPACE_INVENTORY_UNSAFE,
          'Workspace entry changed during inventory',
          {},
          cause
        )
      }
      return freezeDomainValue({
        name: entry.name,
        isDirectory: entry.isDirectory() && metadata.isDirectory(),
        isSymlink: entry.isSymbolicLink() || metadata.isSymbolicLink()
      })
    }))
  }

  #classify(snapshot, occurredAt, cleanupLeaseOwner) {
    const paths = expectedPaths(this.storageRoot, snapshot.sessionId)
    const key = recoverySha256(snapshot.workspaceKey)
    const base = {
      kind: 'workspace',
      snapshot,
      paths,
      resourceKeySha256: key
    }

    if (
      snapshot.workspaceKey !== `workspace-${snapshot.sessionId}` ||
      snapshot.canonicalPath !== paths.treePath
    ) {
      return {
        ...base,
        decision: E3_RECOVERY_DECISION.QUARANTINE_REQUIRED,
        reasonCode: E3_RECOVERY_REASON.PATH_MISMATCH
      }
    }

    const rootExists = existsSync(paths.workspaceRoot)
    if (!rootExists) {
      if (snapshot.workspaceState === E3_WORKSPACE_STATE.REMOVED) {
        return {
          ...base,
          decision: snapshot.sessionStatus === E3_SESSION_STATUS.EXPORTED
            ? E3_RECOVERY_DECISION.FINALIZED
            : E3_RECOVERY_DECISION.ALREADY_CLEAN,
          reasonCode: snapshot.sessionStatus === E3_SESSION_STATUS.EXPORTED
            ? E3_RECOVERY_REASON.EXPORTED_ALREADY_REMOVED
            : E3_RECOVERY_REASON.REMOVED_AND_ABSENT,
          finalizeOnly: snapshot.sessionStatus === E3_SESSION_STATUS.EXPORTED
        }
      }
      if (
        snapshot.workspaceState === E3_WORKSPACE_STATE.REMOVING &&
        CLEANUP_STATUSES.has(snapshot.sessionStatus)
      ) {
        return {
          ...base,
          decision: E3_RECOVERY_DECISION.CLEANED,
          reasonCode: E3_RECOVERY_REASON.INTERRUPTED_REMOVAL,
          cleanup: true
        }
      }
      return {
        ...base,
        decision: E3_RECOVERY_DECISION.QUARANTINE_REQUIRED,
        reasonCode: E3_RECOVERY_REASON.ROOT_MISSING
      }
    }

    let rootMetadata
    let canonicalRoot
    try {
      rootMetadata = lstatSync(paths.workspaceRoot)
      canonicalRoot = realpathSync(paths.workspaceRoot)
    } catch {
      return {
        ...base,
        decision: E3_RECOVERY_DECISION.QUARANTINE_REQUIRED,
        reasonCode: E3_RECOVERY_REASON.ROOT_UNSAFE
      }
    }
    if (
      !rootMetadata.isDirectory() ||
      rootMetadata.isSymbolicLink() ||
      canonicalRoot !== resolve(paths.workspaceRoot)
    ) {
      return {
        ...base,
        decision: E3_RECOVERY_DECISION.QUARANTINE_REQUIRED,
        reasonCode: E3_RECOVERY_REASON.ROOT_UNSAFE
      }
    }
    if (snapshot.workspaceState === E3_WORKSPACE_STATE.REMOVED) {
      return {
        ...base,
        decision: E3_RECOVERY_DECISION.QUARANTINE_REQUIRED,
        reasonCode: E3_RECOVERY_REASON.MANIFEST_MISMATCH
      }
    }
    if (snapshot.workspaceState === E3_WORKSPACE_STATE.QUARANTINED) {
      return {
        ...base,
        decision: E3_RECOVERY_DECISION.QUARANTINE_REQUIRED,
        reasonCode: E3_RECOVERY_REASON.WORKSPACE_QUARANTINED
      }
    }
    if (!existsSync(paths.manifestPath)) {
      return {
        ...base,
        decision: E3_RECOVERY_DECISION.QUARANTINE_REQUIRED,
        reasonCode: E3_RECOVERY_REASON.MANIFEST_MISSING
      }
    }

    let verified
    try {
      verified = readVerifiedWorkspaceManifest(
        paths.manifestPath,
        snapshot.manifestSha256
      )
    } catch {
      return {
        ...base,
        decision: E3_RECOVERY_DECISION.QUARANTINE_REQUIRED,
        reasonCode: E3_RECOVERY_REASON.MANIFEST_TAMPERED
      }
    }
    if (!validateManifest(verified.manifest, snapshot, paths)) {
      return {
        ...base,
        decision: E3_RECOVERY_DECISION.QUARANTINE_REQUIRED,
        reasonCode: E3_RECOVERY_REASON.MANIFEST_MISMATCH
      }
    }

    const processes = safeAssociatedArray(
      verified.manifest.associatedProcesses
    )
    const containers = safeAssociatedArray(
      verified.manifest.associatedContainers
    )
    const ports = safeAssociatedArray(verified.manifest.portLeases)
    if (!processes || !containers || !ports) {
      return {
        ...base,
        decision: E3_RECOVERY_DECISION.QUARANTINE_REQUIRED,
        reasonCode: E3_RECOVERY_REASON.INVALID_ASSOCIATED_RESOURCE
      }
    }

    if (snapshot.activeValidationCount > 0) {
      return {
        ...base,
        decision: E3_RECOVERY_DECISION.RETAIN_ACTIVE,
        reasonCode: E3_RECOVERY_REASON.ACTIVE_VALIDATION
      }
    }
    if (snapshot.openIntentCount > 0) {
      return {
        ...base,
        decision: E3_RECOVERY_DECISION.RETAIN_ACTIVE,
        reasonCode: E3_RECOVERY_REASON.OPEN_OPERATION_INTENT
      }
    }
    if (
      leaseIsValid(snapshot.sessionLease, occurredAt) &&
      snapshot.sessionLease.owner !== cleanupLeaseOwner
    ) {
      return {
        ...base,
        decision: E3_RECOVERY_DECISION.RETAIN_ACTIVE,
        reasonCode: E3_RECOVERY_REASON.VALID_SESSION_LEASE
      }
    }
    if (
      leaseIsValid(snapshot.workspaceLease, occurredAt) &&
      snapshot.workspaceLease.owner !== cleanupLeaseOwner
    ) {
      return {
        ...base,
        decision: E3_RECOVERY_DECISION.RETAIN_ACTIVE,
        reasonCode: E3_RECOVERY_REASON.VALID_WORKSPACE_LEASE
      }
    }

    const processState = inspectAssociated(
      processes,
      this.processInspector
    )
    const containerState = inspectAssociated(
      containers,
      this.containerInspector
    )
    const portState = inspectAssociated(ports, this.portInspector)
    if (
      processState.unknown ||
      containerState.unknown ||
      portState.unknown
    ) {
      return {
        ...base,
        decision: E3_RECOVERY_DECISION.QUARANTINE_REQUIRED,
        reasonCode: E3_RECOVERY_REASON.INSPECTOR_UNAVAILABLE
      }
    }
    if (processState.live) {
      return {
        ...base,
        decision: E3_RECOVERY_DECISION.RETAIN_ACTIVE,
        reasonCode: E3_RECOVERY_REASON.LIVE_PROCESS
      }
    }
    if (containerState.live) {
      return {
        ...base,
        decision: E3_RECOVERY_DECISION.RETAIN_ACTIVE,
        reasonCode: E3_RECOVERY_REASON.LIVE_CONTAINER
      }
    }
    if (portState.live) {
      return {
        ...base,
        decision: E3_RECOVERY_DECISION.RETAIN_ACTIVE,
        reasonCode: E3_RECOVERY_REASON.LIVE_PORT
      }
    }

    if (!CLEANUP_STATUSES.has(snapshot.sessionStatus)) {
      return {
        ...base,
        decision: E3_RECOVERY_DECISION.RETAIN_ACTIVE,
        reasonCode: E3_RECOVERY_REASON.ACTIVE_SESSION
      }
    }
    const age = Math.max(0, occurredAt - snapshot.sessionUpdatedAt)
    if (age < retentionMs(snapshot)) {
      return {
        ...base,
        decision: E3_RECOVERY_DECISION.RETAIN_ACTIVE,
        reasonCode: E3_RECOVERY_REASON.RETENTION_NOT_REACHED
      }
    }
    if (
      snapshot.workspaceState !== E3_WORKSPACE_STATE.READY &&
      snapshot.workspaceState !== E3_WORKSPACE_STATE.REMOVING
    ) {
      return {
        ...base,
        decision: E3_RECOVERY_DECISION.QUARANTINE_REQUIRED,
        reasonCode: E3_RECOVERY_REASON.UNSUPPORTED_WORKSPACE_STATE
      }
    }

    return {
      ...base,
      decision: E3_RECOVERY_DECISION.CLEANED,
      reasonCode: snapshot.workspaceState === E3_WORKSPACE_STATE.REMOVING
        ? E3_RECOVERY_REASON.INTERRUPTED_REMOVAL
        : snapshot.sessionStatus === E3_SESSION_STATUS.EXPORTED
          ? E3_RECOVERY_REASON.EXPORTED_WORKSPACE
          : E3_RECOVERY_REASON.TERMINAL_WORKSPACE,
      cleanup: true
    }
  }

  #execute(plan, input) {
    const actionAt = this.now()
    this.repository.assertCleanupLease({
      owner: input.cleanupLeaseOwner,
      fencingToken: input.cleanupFencingToken,
      occurredAt: actionAt
    })
    if (plan.kind === 'unknown') {
      return decisionBase(input.runId, actionAt, {
        resourceType: E3_RECOVERY_RESOURCE_TYPE.UNKNOWN_WORKSPACE,
        resourceKeySha256: recoverySha256(plan.entry.name),
        decision: E3_RECOVERY_DECISION.QUARANTINE_REQUIRED,
        reasonCode: plan.reasonCode,
        details: {
          directory: plan.entry.isDirectory,
          symlink: plan.entry.isSymlink
        }
      })
    }

    const snapshot = plan.snapshot
    let sessionLease = snapshot.sessionLease
    let workspaceLease = snapshot.workspaceLease
    let finalState = snapshot.workspaceState
    let reclaimedBytes = 0

    if (plan.cleanup || plan.finalizeOnly) {
      const expiresAt = actionAt + input.leaseDurationMs
      sessionLease = (
        leaseIsValid(snapshot.sessionLease, actionAt) &&
        snapshot.sessionLease.owner === input.cleanupLeaseOwner
      )
        ? snapshot.sessionLease
        : this.repository.claimExpiredLease({
            resourceType: E3_LEASE_RESOURCE_TYPE.SESSION,
            sessionId: snapshot.sessionId,
            owner: input.cleanupLeaseOwner,
            occurredAt: actionAt,
            expiresAt,
            expectedLease: snapshot.sessionLease
          })
      if (plan.cleanup) {
        workspaceLease = (
          leaseIsValid(snapshot.workspaceLease, actionAt) &&
          snapshot.workspaceLease.owner === input.cleanupLeaseOwner
        )
          ? snapshot.workspaceLease
          : this.repository.claimExpiredLease({
              resourceType: E3_LEASE_RESOURCE_TYPE.WORKSPACE,
              sessionId: snapshot.sessionId,
              owner: input.cleanupLeaseOwner,
              occurredAt: actionAt,
              expiresAt,
              expectedLease: snapshot.workspaceLease
            })
        this.faultInjector('recovery.after_lease_takeover')
        try {
          this.workspaceManager.removeWorkspace({
            sessionId: snapshot.sessionId,
            leaseOwner: input.cleanupLeaseOwner,
            fencingToken: workspaceLease.fencingToken,
            removedAt: actionAt
          })
        } catch (cause) {
          recoveryError(
            E3_RECOVERY_ERROR.CLEANUP_FAILED,
            'Trusted workspace cleanup failed',
            { sessionId: snapshot.sessionId },
            cause
          )
        }
        finalState = E3_WORKSPACE_STATE.REMOVED
        reclaimedBytes = snapshot.logicalSizeBytes
        this.faultInjector('recovery.after_workspace_cleanup')
      }
      if (snapshot.sessionStatus === E3_SESSION_STATUS.EXPORTED) {
        try {
          this.sessionFinalizer.completeExportedSession({
            sessionId: snapshot.sessionId,
            actorId: input.actorId,
            requestId:
              `e3-recovery-complete-${recoverySha256(input.requestId).slice(0, 32)}`,
            occurredAt: actionAt,
            leaseOwner: input.cleanupLeaseOwner,
            fencingToken: sessionLease.fencingToken
          })
        } catch (cause) {
          recoveryError(
            E3_RECOVERY_ERROR.SESSION_FINALIZATION_FAILED,
            'Workspace was cleaned but session finalization failed',
            { sessionId: snapshot.sessionId },
            cause
          )
        }
        this.faultInjector('recovery.after_session_finalize')
      }
    }

    const effectiveDecision = plan.finalizeOnly
      ? E3_RECOVERY_DECISION.FINALIZED
      : plan.decision
    return decisionBase(input.runId, actionAt, {
      resourceType: E3_RECOVERY_RESOURCE_TYPE.WORKSPACE,
      resourceKeySha256: plan.resourceKeySha256,
      sessionId: snapshot.sessionId,
      workspaceKey: snapshot.workspaceKey,
      initialState: snapshot.workspaceState,
      finalState,
      decision: effectiveDecision,
      reasonCode: plan.reasonCode,
      manifestSha256: snapshot.manifestSha256,
      sessionFencingToken: sessionLease?.fencingToken ?? null,
      workspaceFencingToken: workspaceLease?.fencingToken ?? null,
      logicalSizeBytes: snapshot.logicalSizeBytes,
      reclaimedBytes,
      details: {
        policyVersion: E3_RECOVERY_POLICY_VERSION,
        productiveApplyEnabled: false
      }
    })
  }
}

export function recoveryRuntimeBoundaryFingerprint() {
  return recoverySha256(canonicalRecoveryJson({
    feature: 'recovery-reaper',
    defaultEnabled: false,
    productiveApplyEnabled: false,
    unknownPathsDeleted: false
  }))
}
