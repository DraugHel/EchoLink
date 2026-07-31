import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  E3_LEASE_RESOURCE_TYPE,
  E3_SESSION_STATUS
} from '../server/e3/core/contracts.js'
import {
  E3_RECOVERY_DECISION,
  E3_RECOVERY_POLICY_SHA256,
  E3_RECOVERY_POLICY_VERSION,
  E3_RECOVERY_REASON,
  recoveryFeatureEnabled
} from '../server/e3/recovery/contracts.js'
import {
  E3_RECOVERY_ERROR,
  E3RecoveryError
} from '../server/e3/recovery/errors.js'
import {
  RecoveryReaperService,
  recoveryRuntimeBoundaryFingerprint
} from '../server/e3/recovery/recoveryService.js'
import {
  E3_WORKSPACE_STATE
} from '../server/e3/workspaces/contracts.js'
import {
  publishWorkspaceManifest
} from '../server/e3/workspaces/workspaceManifest.js'

const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000'
const SECOND_SESSION_ID =
  '123e4567-e89b-42d3-a456-426614174001'
const RUN_ID = '223e4567-e89b-42d3-a456-426614174000'
const BASE_COMMIT = 'a'.repeat(40)
const TREE_SHA = 'b'.repeat(40)
const OCCURRED_AT = 200_000_000
const OWNER = 'recovery-manager-1'

function recoveryCode(code) {
  return error => (
    error instanceof E3RecoveryError &&
    error.code === code
  )
}

function clone(value) {
  return structuredClone(value)
}

class FakeRecoveryRepository {
  constructor(snapshots = []) {
    this.snapshots = snapshots
    this.runs = new Map()
    this.cleanupLease = {
      resourceType: E3_LEASE_RESOURCE_TYPE.CLEANUP,
      resourceKey: 'global',
      owner: OWNER,
      acquiredAt: 1,
      heartbeatAt: OCCURRED_AT - 100,
      expiresAt: OCCURRED_AT + 100_000,
      fencingToken: 7
    }
  }

  getRunByRequestId(requestId) {
    return this.runs.get(requestId) ?? null
  }

  assertCleanupLease({ owner, fencingToken, occurredAt }) {
    if (
      owner !== this.cleanupLease.owner ||
      fencingToken !== this.cleanupLease.fencingToken
    ) {
      throw new E3RecoveryError(
        E3_RECOVERY_ERROR.CLEANUP_LEASE_MISMATCH,
        'cleanup lease mismatch'
      )
    }
    if (this.cleanupLease.expiresAt <= occurredAt) {
      throw new E3RecoveryError(
        E3_RECOVERY_ERROR.CLEANUP_LEASE_EXPIRED,
        'cleanup lease expired'
      )
    }
    return clone(this.cleanupLease)
  }

  listWorkspaceSnapshots() {
    return this.snapshots.map(clone)
  }

  claimExpiredLease({
    resourceType,
    sessionId,
    owner,
    occurredAt,
    expiresAt,
    expectedLease
  }) {
    const snapshot = this.snapshots.find(
      item => item.sessionId === sessionId
    )
    const field = resourceType === E3_LEASE_RESOURCE_TYPE.SESSION
      ? 'sessionLease'
      : 'workspaceLease'
    const current = snapshot[field]
    assert.deepEqual(current, expectedLease)
    if (current && current.expiresAt > occurredAt) {
      throw new E3RecoveryError(
        E3_RECOVERY_ERROR.LEASE_TAKEOVER_BLOCKED,
        'lease is live'
      )
    }
    const lease = {
      resourceType,
      resourceKey: sessionId,
      owner,
      acquiredAt: occurredAt,
      heartbeatAt: occurredAt,
      expiresAt,
      fencingToken: current ? current.fencingToken + 1 : 1
    }
    snapshot[field] = lease
    return clone(lease)
  }

  recordRun(run, decisions) {
    const existing = this.runs.get(run.requestId)
    if (existing) {
      if (existing.run.requestSha256 !== run.requestSha256) {
        throw new E3RecoveryError(
          E3_RECOVERY_ERROR.REQUEST_REPLAY_CONFLICT,
          'request conflict'
        )
      }
      return { ...clone(existing), replayed: true }
    }
    const result = {
      run: { ...clone(run), result: 'SUCCEEDED' },
      decisions: clone(decisions),
      replayed: false
    }
    this.runs.set(run.requestId, result)
    return clone(result)
  }
}

function request(overrides = {}) {
  return {
    runId: RUN_ID,
    actorId: 'user-1',
    requestId: 'recovery-request-0001',
    occurredAt: OCCURRED_AT,
    cleanupLeaseOwner: OWNER,
    cleanupFencingToken: 7,
    leaseDurationMs: 120_000,
    ...overrides
  }
}

function createHarness(t, {
  sessionId = SESSION_ID,
  sessionStatus = E3_SESSION_STATUS.EXPORTED,
  workspaceState = E3_WORKSPACE_STATE.READY,
  sessionUpdatedAt = OCCURRED_AT - 100_000,
  sessionLeaseExpiresAt = OCCURRED_AT - 1,
  workspaceLeaseExpiresAt = OCCURRED_AT - 1,
  associatedProcesses = [],
  associatedContainers = [],
  portLeases = [],
  activeValidationCount = 0,
  openIntentCount = 0,
  createWorkspace = true,
  manifestMutation = null,
  faultInjector = () => {},
  processInspector = () => false,
  containerInspector = () => false,
  portInspector = () => false,
  enabled = true
} = {}) {
  const parent = mkdtempSync(join(tmpdir(), 'e3-recovery-'))
  const storageRoot = join(parent, 'storage')
  const workspacesPath = join(storageRoot, 'workspaces')
  const locksPath = join(storageRoot, 'locks')
  mkdirSync(workspacesPath, { recursive: true })
  mkdirSync(locksPath, { recursive: true })
  const workspaceRoot = join(workspacesPath, sessionId)
  const treePath = join(workspaceRoot, 'tree')
  const manifestPath = join(workspaceRoot, 'manifest.json')
  let manifestSha256 = 'c'.repeat(64)

  if (createWorkspace) {
    mkdirSync(treePath, { recursive: true })
    writeFileSync(join(treePath, 'example.txt'), 'pilot\n')
    const manifest = {
      schemaVersion: 1,
      sessionId,
      workspaceKey: `workspace-${sessionId}`,
      baseCommit: BASE_COMMIT,
      treeSha: TREE_SHA,
      canonicalWorkspacePath: treePath,
      managerOwner: 'workspace-manager-1',
      workerOwner: null,
      createdAt: 1_000,
      heartbeatAt: 1_000,
      fencingToken: 3,
      allowedRoots: [treePath],
      expectedSubpaths: ['tree', 'manifest.json'],
      associatedProcesses,
      associatedContainers,
      portLeases,
      candidate: null,
      logicalSizeBytes: 6,
      entryCount: 1,
      symlinkCount: 0
    }
    const published = publishWorkspaceManifest(manifestPath, manifest)
    manifestSha256 = published.sha256
    if (manifestMutation) manifestMutation({ manifestPath, workspaceRoot })
  }

  const snapshot = {
    sessionId,
    sessionStatus,
    sessionVersion: 10,
    sessionUpdatedAt,
    workspaceKey: `workspace-${sessionId}`,
    workspaceState,
    baseCommit: BASE_COMMIT,
    treeSha: TREE_SHA,
    canonicalPath: treePath,
    manifestSha256,
    managerOwner: 'workspace-manager-1',
    createdAt: 1_000,
    heartbeatAt: 1_000,
    fencingToken: 3,
    logicalSizeBytes: 6,
    entryCount: 1,
    symlinkCount: 0,
    removedAt: workspaceState === E3_WORKSPACE_STATE.REMOVED
      ? OCCURRED_AT - 1
      : null,
    sessionLease: sessionLeaseExpiresAt === null
      ? null
      : {
          resourceType: E3_LEASE_RESOURCE_TYPE.SESSION,
          resourceKey: sessionId,
          owner: 'old-session-owner',
          acquiredAt: 1,
          heartbeatAt: 2,
          expiresAt: sessionLeaseExpiresAt,
          fencingToken: 4
        },
    workspaceLease: workspaceLeaseExpiresAt === null
      ? null
      : {
          resourceType: E3_LEASE_RESOURCE_TYPE.WORKSPACE,
          resourceKey: sessionId,
          owner: 'old-workspace-owner',
          acquiredAt: 1,
          heartbeatAt: 2,
          expiresAt: workspaceLeaseExpiresAt,
          fencingToken: 8
        },
    activeValidationCount,
    openIntentCount
  }
  const repository = new FakeRecoveryRepository([snapshot])
  const finalizations = []
  const workspaceManager = {
    removeWorkspace({ sessionId: id, leaseOwner, fencingToken }) {
      assert.equal(id, sessionId)
      assert.equal(leaseOwner, OWNER)
      assert.equal(
        fencingToken,
        repository.snapshots[0].workspaceLease.fencingToken
      )
      if (existsSync(workspaceRoot)) {
        rmSync(workspaceRoot, { recursive: true, force: false })
      }
      repository.snapshots[0].workspaceState = E3_WORKSPACE_STATE.REMOVED
      repository.snapshots[0].logicalSizeBytes = 0
      repository.snapshots[0].removedAt = OCCURRED_AT
      return { removed: true }
    }
  }
  const sessionFinalizer = {
    completeExportedSession(input) {
      const current = repository.snapshots[0]
      if (current.sessionStatus === E3_SESSION_STATUS.COMPLETED) {
        return { replayed: true }
      }
      assert.equal(current.sessionStatus, E3_SESSION_STATUS.EXPORTED)
      assert.equal(input.leaseOwner, OWNER)
      assert.equal(
        input.fencingToken,
        current.sessionLease.fencingToken
      )
      current.sessionStatus = E3_SESSION_STATUS.COMPLETED
      current.sessionVersion += 1
      finalizations.push(clone(input))
      return { replayed: false }
    }
  }
  const service = new RecoveryReaperService({
    repository,
    storageRoot,
    workspaceManager,
    sessionFinalizer,
    enabled,
    processInspector,
    containerInspector,
    portInspector,
    faultInjector,
    now: () => OCCURRED_AT,
    forbiddenRoots: [join(parent, 'forbidden-production')]
  })
  const outsideSentinel = join(parent, 'outside-sentinel.txt')
  writeFileSync(outsideSentinel, 'must survive\n')

  t.after(() => rmSync(parent, { recursive: true, force: true }))
  return {
    parent,
    storageRoot,
    workspacesPath,
    workspaceRoot,
    manifestPath,
    snapshot,
    repository,
    service,
    finalizations,
    outsideSentinel
  }
}

test('Recovery bleibt standardmäßig aus und die Policy ist stabil', t => {
  assert.equal(recoveryFeatureEnabled({}), false)
  assert.equal(recoveryFeatureEnabled({ E3_RECOVERY_ENABLED: 'false' }), false)
  assert.equal(recoveryFeatureEnabled({ E3_RECOVERY_ENABLED: 'true' }), true)
  assert.equal(E3_RECOVERY_POLICY_VERSION, 'e3-recovery-policy-v1')
  assert.match(E3_RECOVERY_POLICY_SHA256, /^[0-9a-f]{64}$/)
  assert.match(recoveryRuntimeBoundaryFingerprint(), /^[0-9a-f]{64}$/)

  const disabled = createHarness(t, { enabled: false })
  assert.throws(
    () => disabled.service.run(request()),
    recoveryCode(E3_RECOVERY_ERROR.FEATURE_DISABLED)
  )
  assert.equal(existsSync(disabled.workspaceRoot), true)
})

test('Exportierter Pilot wird nach abgelaufenen Leases bereinigt und abgeschlossen', t => {
  const h = createHarness(t)
  const result = h.service.run(request())
  assert.equal(result.replayed, false)
  assert.equal(result.run.cleanedCount, 1)
  assert.equal(result.run.reclaimedBytes, 6)
  assert.equal(result.decisions[0].decision, E3_RECOVERY_DECISION.CLEANED)
  assert.equal(result.decisions[0].reasonCode, E3_RECOVERY_REASON.EXPORTED_WORKSPACE)
  assert.equal(existsSync(h.workspaceRoot), false)
  assert.equal(h.snapshot.workspaceState, E3_WORKSPACE_STATE.REMOVED)
  assert.equal(h.snapshot.sessionStatus, E3_SESSION_STATUS.COMPLETED)
  assert.equal(h.finalizations.length, 1)
  assert.equal(readFileSync(h.outsideSentinel, 'utf8'), 'must survive\n')
})

test('Falsche oder abgelaufene globale Cleanup-Lease stoppt vor der Inventur', t => {
  const mismatch = createHarness(t)
  assert.throws(
    () => mismatch.service.run(request({ cleanupFencingToken: 8 })),
    recoveryCode(E3_RECOVERY_ERROR.CLEANUP_LEASE_MISMATCH)
  )
  assert.equal(existsSync(mismatch.workspaceRoot), true)

  const expired = createHarness(t, { sessionId: SECOND_SESSION_ID })
  expired.repository.cleanupLease.expiresAt = OCCURRED_AT
  assert.throws(
    () => expired.service.run(request({
      runId: '223e4567-e89b-42d3-a456-426614174010',
      requestId: 'recovery-cleanup-expired'
    })),
    recoveryCode(E3_RECOVERY_ERROR.CLEANUP_LEASE_EXPIRED)
  )
  assert.equal(existsSync(expired.workspaceRoot), true)
})

test('Gültige Session- oder Workspace-Lease blockiert Cleanup', t => {
  for (const field of ['sessionLeaseExpiresAt', 'workspaceLeaseExpiresAt']) {
    const h = createHarness(t, { [field]: OCCURRED_AT + 1 })
    const result = h.service.run(request({
      runId: field === 'sessionLeaseExpiresAt'
        ? RUN_ID
        : '223e4567-e89b-42d3-a456-426614174001',
      requestId: `recovery-${field}`
    }))
    assert.equal(result.run.retainedCount, 1)
    assert.equal(result.decisions[0].decision, E3_RECOVERY_DECISION.RETAIN_ACTIVE)
    assert.equal(existsSync(h.workspaceRoot), true)
  }
})

test('Lebender Prozess blockiert Cleanup trotz abgelaufener Lease', t => {
  const h = createHarness(t, {
    associatedProcesses: [4242],
    processInspector: pid => pid === 4242
  })
  const result = h.service.run(request())
  assert.equal(result.decisions[0].reasonCode, E3_RECOVERY_REASON.LIVE_PROCESS)
  assert.equal(result.run.retainedCount, 1)
  assert.equal(existsSync(h.workspaceRoot), true)
})

test('Lebender Container oder Port blockiert Cleanup ebenfalls', t => {
  const cases = [
    {
      sessionId: SESSION_ID,
      options: {
        associatedContainers: ['container-1'],
        containerInspector: value => value === 'container-1'
      },
      reason: E3_RECOVERY_REASON.LIVE_CONTAINER
    },
    {
      sessionId: SECOND_SESSION_ID,
      options: {
        portLeases: ['port-4173'],
        portInspector: value => value === 'port-4173'
      },
      reason: E3_RECOVERY_REASON.LIVE_PORT
    }
  ]
  cases.forEach((entry, index) => {
    const h = createHarness(t, {
      sessionId: entry.sessionId,
      ...entry.options
    })
    const result = h.service.run(request({
      runId: `223e4567-e89b-42d3-a456-42661417402${index}`,
      requestId: `recovery-live-resource-${index}`
    }))
    assert.equal(result.decisions[0].reasonCode, entry.reason)
    assert.equal(result.run.retainedCount, 1)
    assert.equal(existsSync(h.workspaceRoot), true)
  })
})

test('Unverfügbarer Inspector und manipuliertes Manifest fail-closed', t => {
  const unknown = createHarness(t, {
    associatedContainers: ['container-1'],
    containerInspector: () => null
  })
  const unknownResult = unknown.service.run(request())
  assert.equal(unknownResult.run.quarantinedCount, 1)
  assert.equal(
    unknownResult.decisions[0].reasonCode,
    E3_RECOVERY_REASON.INSPECTOR_UNAVAILABLE
  )
  assert.equal(existsSync(unknown.workspaceRoot), true)

  const tampered = createHarness(t, {
    sessionId: SECOND_SESSION_ID,
    manifestMutation: ({ manifestPath }) => {
      writeFileSync(manifestPath, '{"tampered":true}\n')
    }
  })
  const tamperedResult = tampered.service.run(request({
    runId: '223e4567-e89b-42d3-a456-426614174002',
    requestId: 'recovery-request-tampered'
  }))
  assert.equal(tamperedResult.run.quarantinedCount, 1)
  assert.equal(
    tamperedResult.decisions[0].reasonCode,
    E3_RECOVERY_REASON.MANIFEST_TAMPERED
  )
  assert.equal(existsSync(tampered.workspaceRoot), true)
})

test('Unbekannte Ordner werden nur gehasht protokolliert und nie gelöscht', t => {
  const h = createHarness(t)
  const unknownPath = join(h.workspacesPath, 'totally-unknown-resource')
  mkdirSync(unknownPath)
  writeFileSync(join(unknownPath, 'keep.txt'), 'keep\n')
  const result = h.service.run(request())
  const unknown = result.decisions.find(
    item => item.resourceType === 'unknown_workspace'
  )
  assert.ok(unknown)
  assert.equal(unknown.decision, E3_RECOVERY_DECISION.QUARANTINE_REQUIRED)
  assert.equal(unknown.reasonCode, E3_RECOVERY_REASON.UNKNOWN_DIRECTORY)
  assert.equal(unknown.workspaceKey, null)
  assert.match(unknown.resourceKeySha256, /^[0-9a-f]{64}$/)
  assert.equal(existsSync(unknownPath), true)
})

test('Offene Intents, laufende Validierung und Retention halten Ressourcen zurück', t => {
  const cases = [
    {
      options: { openIntentCount: 1 },
      reason: E3_RECOVERY_REASON.OPEN_OPERATION_INTENT
    },
    {
      options: { activeValidationCount: 1 },
      reason: E3_RECOVERY_REASON.ACTIVE_VALIDATION
    },
    {
      options: {
        sessionStatus: E3_SESSION_STATUS.FAILED,
        sessionUpdatedAt: OCCURRED_AT - 1000
      },
      reason: E3_RECOVERY_REASON.RETENTION_NOT_REACHED
    }
  ]
  cases.forEach((entry, index) => {
    const h = createHarness(t, {
      sessionId: index === 0
        ? SESSION_ID
        : index === 1
          ? SECOND_SESSION_ID
          : '123e4567-e89b-42d3-a456-426614174002',
      ...entry.options
    })
    const result = h.service.run(request({
      runId: `223e4567-e89b-42d3-a456-42661417410${index}`,
      requestId: `recovery-retain-${index}`
    }))
    assert.equal(result.decisions[0].reasonCode, entry.reason)
    assert.equal(result.run.retainedCount, 1)
  })
})

test('Unterbrochene Entfernung wird idempotent fertiggestellt', t => {
  const h = createHarness(t, {
    workspaceState: E3_WORKSPACE_STATE.REMOVING,
    createWorkspace: false
  })
  const result = h.service.run(request())
  assert.equal(result.run.cleanedCount, 1)
  assert.equal(result.decisions[0].reasonCode, E3_RECOVERY_REASON.INTERRUPTED_REMOVAL)
  assert.equal(h.snapshot.sessionStatus, E3_SESSION_STATUS.COMPLETED)
})

test('Exakter Replay ist idempotent; abweichende Bytes werden abgewiesen', t => {
  const h = createHarness(t)
  const first = h.service.run(request())
  const replay = h.service.run(request())
  assert.equal(first.replayed, false)
  assert.equal(replay.replayed, true)
  assert.equal(h.finalizations.length, 1)
  assert.throws(
    () => h.service.run(request({ actorId: 'other-user' })),
    recoveryCode(E3_RECOVERY_ERROR.REQUEST_REPLAY_CONFLICT)
  )
})

test('Crash nach Workspace-Cleanup wird beim selben Request sicher wiederaufgenommen', t => {
  let failOnce = true
  const h = createHarness(t, {
    faultInjector(point) {
      if (point === 'recovery.after_workspace_cleanup' && failOnce) {
        failOnce = false
        throw new Error('injected crash')
      }
    }
  })
  assert.throws(() => h.service.run(request()), /injected crash/)
  assert.equal(existsSync(h.workspaceRoot), false)
  assert.equal(h.snapshot.workspaceState, E3_WORKSPACE_STATE.REMOVED)
  assert.equal(h.snapshot.sessionStatus, E3_SESSION_STATUS.EXPORTED)
  assert.equal(h.repository.runs.size, 0)

  const recovered = h.service.run(request())
  assert.equal(recovered.run.finalizedCount, 1)
  assert.equal(recovered.decisions[0].decision, E3_RECOVERY_DECISION.FINALIZED)
  assert.equal(h.snapshot.sessionStatus, E3_SESSION_STATUS.COMPLETED)
  assert.equal(h.repository.runs.size, 1)
})

test('Crash nach Lease-Übernahme und nach Session-Abschluss bleibt wiederaufnehmbar', t => {
  for (const faultPoint of [
    'recovery.after_lease_takeover',
    'recovery.after_session_finalize'
  ]) {
    let failOnce = true
    const sessionId = faultPoint === 'recovery.after_lease_takeover'
      ? SESSION_ID
      : SECOND_SESSION_ID
    const h = createHarness(t, {
      sessionId,
      faultInjector(point) {
        if (point === faultPoint && failOnce) {
          failOnce = false
          throw new Error(`injected ${faultPoint}`)
        }
      }
    })
    const input = request({
      runId: faultPoint === 'recovery.after_lease_takeover'
        ? '223e4567-e89b-42d3-a456-426614174030'
        : '223e4567-e89b-42d3-a456-426614174031',
      requestId: `recovery-crash-${faultPoint.split('.').at(-1)}`
    })
    assert.throws(() => h.service.run(input), new RegExp(faultPoint))
    assert.equal(h.repository.runs.size, 0)

    const recovered = h.service.run(input)
    assert.equal(recovered.replayed, false)
    assert.equal(h.snapshot.sessionStatus, E3_SESSION_STATUS.COMPLETED)
    assert.equal(existsSync(h.workspaceRoot), false)
    assert.equal(h.repository.runs.size, 1)
  }
})

test('Crash nach durablem Audit wird als exakter Replay gelesen', t => {
  let failOnce = true
  const h = createHarness(t, {
    faultInjector(point) {
      if (point === 'recovery.after_record' && failOnce) {
        failOnce = false
        throw new Error('injected after record')
      }
    }
  })
  assert.throws(() => h.service.run(request()), /injected after record/)
  assert.equal(h.repository.runs.size, 1)
  const replay = h.service.run(request())
  assert.equal(replay.replayed, true)
  assert.equal(h.finalizations.length, 1)
})

test('Symlink als Workspace-Wurzel wird niemals verfolgt oder gelöscht', t => {
  const h = createHarness(t)
  const target = join(h.parent, 'symlink-target')
  mkdirSync(target)
  writeFileSync(join(target, 'keep.txt'), 'keep\n')
  rmSync(h.workspaceRoot, { recursive: true })
  symlinkSync(target, h.workspaceRoot)
  const result = h.service.run(request())
  assert.equal(result.run.quarantinedCount, 1)
  assert.equal(result.decisions[0].reasonCode, E3_RECOVERY_REASON.ROOT_UNSAFE)
  assert.equal(readFileSync(join(target, 'keep.txt'), 'utf8'), 'keep\n')
})
