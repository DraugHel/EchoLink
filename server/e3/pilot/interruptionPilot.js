import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  E3_LEASE_RESOURCE_TYPE,
  E3_SESSION_COMMAND,
  E3_SESSION_STATUS
} from '../core/contracts.js'
import { E3_EDITOR_OPERATION } from '../editor/contracts.js'
import { SessionEditorService } from '../editor/sessionEditorService.js'
import { sha256 } from '../editor/safeTextFilesystem.js'
import { ArtifactStore } from '../artifacts/artifactStore.js'
import { openEditorDatabase } from '../persistence/database.js'
import { EditorRepository } from '../persistence/editorRepository.js'
import { WorkspaceManager } from '../workspaces/workspaceManager.js'
import { ValidationSnapshotMaterializer } from '../validation/snapshotMaterializer.js'
import { PilotExportService } from '../export/pilotExportService.js'
import { RecoveryReaperService } from '../recovery/recoveryService.js'
import { RecoverySessionFinalizer } from '../recovery/sessionFinalizer.js'
import {
  E3_RECOVERY_DECISION,
  E3_RECOVERY_REASON
} from '../recovery/contracts.js'
import {
  E3_OPERATIONAL_PILOT_INTERRUPTION_CASES,
  assertPilotPathPolicy,
  completeOperationalPilotSuccess,
  createOperationalPilotCaseContext,
  prepareOperationalPilotCandidate,
  runOperationalPilotValidation
} from './operationalPilot.js'

export { E3_OPERATIONAL_PILOT_INTERRUPTION_CASES }

export const E3_OPERATIONAL_PILOT_INTERRUPTION_EXIT_CODE = 86

const SESSION_OWNER = 'e3-pilot-session'
const WORKSPACE_OWNER = 'e3-pilot-workspace'
const ACTOR = 'e3-pilot-operator'
const RECOVERY_OWNER = 'e3-pilot-recovery'
const LEASE_MS = 60 * 60 * 1_000
const WORKER_FLAG = 'E3_PILOT_INTERRUPTION_WORKER'
const STATE_NAME = 'interruption-state.json'
const MUTATION_PATH = 'tests/fixtures/e3-validation-ui/app.js'
const MUTATION_SEARCH =
  "app.textContent = 'E3 isolated UI validation is ready.'"
const MUTATION_REPLACEMENT =
  "app.textContent = 'E3 interrupted mutation recovered.'"

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function isContained(root, candidate) {
  const relation = relative(resolve(root), resolve(candidate))
  return relation === '' || (
    relation !== '..' &&
    !relation.startsWith(`..${sep}`) &&
    !relation.startsWith('../')
  )
}

function assertCommit(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error('Interruption pilot requires a full Git commit')
  }
}

function assertRealDirectory(path, label) {
  const stat = lstatSync(path)
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realpathSync(path) !== resolve(path)
  ) {
    throw new Error(`${label} is not a canonical directory`)
  }
  return resolve(path)
}

function writeDurableJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
  const temporary = `${path}.tmp-${randomUUID()}`
  writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' })
  const descriptor = openSync(temporary, 'r')
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  renameSync(temporary, path)
  chmodSync(path, 0o600)
  return digest(bytes)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function checkpoint(path, state, patch) {
  const next = {
    ...state,
    ...patch,
    checkpointedAt: new Date().toISOString()
  }
  writeDurableJson(path, next)
  return next
}

function fixedRuntime() {
  return Object.freeze({
    run(plan) {
      return Object.freeze({
        status: 'succeeded',
        exitCode: 0,
        signal: null,
        stdout: `${plan.profile.id} interruption-ok\n`,
        stderr: '',
        outputBytes: 0
      })
    }
  })
}

function validateRequest(request) {
  const expected = [
    'format', 'name', 'pilotRoot', 'caseRoot', 'statePath',
    'repositoryRoot', 'sourceRepositoryPath', 'baselineCommit',
    'manifest', 'runId', 'sessionId'
  ].sort()
  const actual = Object.keys(request ?? {}).sort()
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index]) ||
    request.format !== 'echolink-e3-interruption-worker-v1' ||
    !E3_OPERATIONAL_PILOT_INTERRUPTION_CASES.includes(request.name)
  ) {
    throw new Error('Interruption worker request is invalid')
  }
  assertCommit(request.baselineCommit)
  const root = assertPilotPathPolicy({
    pilotRoot: request.pilotRoot,
    repositoryRoot: request.repositoryRoot
  })
  if (
    !isContained(root, request.caseRoot) ||
    !isContained(request.caseRoot, request.statePath) ||
    basename(request.statePath) !== STATE_NAME ||
    request.manifest?.sourceHead !== request.baselineCommit ||
    !/^[0-9a-f]{64}$/.test(request.manifest?.manifestSha256 ?? '') ||
    !/^sha256:[0-9a-f]{64}$/.test(
      request.manifest?.nodeImageDigest ?? ''
    ) ||
    !/^sha256:[0-9a-f]{64}$/.test(
      request.manifest?.playwrightImageDigest ?? ''
    )
  ) {
    throw new Error('Interruption worker binding is invalid')
  }
  return request
}

function validateState(state, statePath) {
  if (
    state?.format !== 'echolink-e3-interruption-state-v1' ||
    !E3_OPERATIONAL_PILOT_INTERRUPTION_CASES.includes(
      state.interruptionCase
    ) ||
    typeof state.runId !== 'string' ||
    typeof state.sessionId !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(state.runId) ||
    !/^[0-9a-f-]{36}$/.test(state.sessionId)
  ) {
    throw new Error('Interruption state identity is invalid')
  }
  assertCommit(state.baselineCommit)
  const root = assertPilotPathPolicy({
    pilotRoot: state.pilotRoot,
    repositoryRoot: state.repositoryRoot
  })
  const caseRoot = resolve(root, `case-success-${state.runId}`)
  const expected = {
    caseRoot,
    statePath: resolve(caseRoot, STATE_NAME),
    databasePath: resolve(caseRoot, 'editor.db'),
    workspaceStorageRoot: resolve(caseRoot, 'workspace-storage'),
    preimageArtifactRoot: resolve(caseRoot, 'preimages'),
    candidateArtifactRoot: resolve(caseRoot, 'candidate-artifacts'),
    validationSnapshotRoot: resolve(caseRoot, 'validation-snapshots'),
    validationOutputRoot: resolve(caseRoot, 'validation-output')
  }
  for (const [field, value] of Object.entries(expected)) {
    if (resolve(state[field]) !== value) {
      throw new Error(`Interruption state path changed: ${field}`)
    }
  }
  if (
    resolve(statePath) !== expected.statePath ||
    state.manifest?.sourceHead !== state.baselineCommit ||
    !/^[0-9a-f]{64}$/.test(state.manifest?.manifestSha256 ?? '') ||
    !/^sha256:[0-9a-f]{64}$/.test(
      state.manifest?.nodeImageDigest ?? ''
    ) ||
    !/^sha256:[0-9a-f]{64}$/.test(
      state.manifest?.playwrightImageDigest ?? ''
    )
  ) {
    throw new Error('Interruption state binding is invalid')
  }
  return state
}

function baseState(context, request) {
  return {
    format: 'echolink-e3-interruption-state-v1',
    interruptionCase: request.name,
    checkpoint: 'CONTEXT_CREATED',
    pilotRoot: request.pilotRoot,
    caseRoot: context.caseRoot,
    statePath: request.statePath,
    baselineCommit: context.baselineCommit,
    manifest: request.manifest,
    repositoryRoot: context.repositoryRoot,
    sourceRepositoryPath: context.sourceRepositoryPath,
    databasePath: context.databasePath,
    workspaceStorageRoot: context.workspaceStorageRoot,
    preimageArtifactRoot: context.preimageArtifactRoot,
    candidateArtifactRoot: context.candidateArtifactRoot,
    validationSnapshotRoot: context.validationSnapshotRoot,
    validationOutputRoot: context.validationOutputRoot,
    runId: context.runId,
    sessionId: context.sessionId,
    createdAt: context.createdAt
  }
}

function prepareEditable(context) {
  const t = context.createdAt
  let session = context.sessions.createSession({
    id: context.sessionId,
    baseCommit: context.baselineCommit,
    createdBy: context.actorId,
    requestSummary: 'E3 interruption mutation',
    createdAt: t,
    leaseOwner: context.sessionOwner,
    leaseExpiresAt: t + LEASE_MS
  }).session
  session = context.sessions.transitionSession({
    type: E3_SESSION_COMMAND.START_PROVISIONING,
    sessionId: context.sessionId,
    expectedVersion: session.version,
    actorId: context.actorId,
    requestId: `interrupt-provision-${context.runId}`,
    occurredAt: t + 1,
    leaseOwner: context.sessionOwner,
    fencingToken: 1
  }).session
  const workspaceLease = context.sessions.claimLease({
    resourceType: E3_LEASE_RESOURCE_TYPE.WORKSPACE,
    resourceKey: context.sessionId,
    owner: context.workspaceOwner,
    occurredAt: t + 2,
    expiresAt: t + LEASE_MS
  })
  const workspace = context.workspaceManager.provisionWorkspace({
    sessionId: context.sessionId,
    leaseOwner: context.workspaceOwner,
    fencingToken: workspaceLease.fencingToken,
    createdAt: t + 3
  })
  session = context.sessions.transitionSession({
    type: E3_SESSION_COMMAND.FINISH_PROVISIONING,
    sessionId: context.sessionId,
    expectedVersion: session.version,
    actorId: context.actorId,
    requestId: `interrupt-ready-${context.runId}`,
    occurredAt: t + 4,
    leaseOwner: context.sessionOwner,
    fencingToken: 1
  }).session
  const file = resolve(workspace.record.canonicalPath, MUTATION_PATH)
  const original = readFileSync(file)
  const text = original.toString('utf8')
  if (text.split(MUTATION_SEARCH).length !== 2) {
    throw new Error('Interruption mutation fixture is not exact')
  }
  const mutation = {
    version: 1,
    type: E3_EDITOR_OPERATION.REPLACE_EXACT,
    path: MUTATION_PATH,
    expectedSha256: sha256(original),
    search: MUTATION_SEARCH,
    replacement: MUTATION_REPLACEMENT,
    expectedMatches: 1
  }
  return {
    session,
    workspaceLease,
    workspacePath: workspace.record.canonicalPath,
    mutation,
    originalSha256: sha256(original),
    postimageSha256: sha256(Buffer.from(
      text.replace(MUTATION_SEARCH, MUTATION_REPLACEMENT)
    ))
  }
}

function interruptMutation(context, request, state) {
  const prepared = prepareEditable(context)
  const intentId = randomUUID()
  const operationId = randomUUID()
  const common = {
    workspacePath: prepared.workspacePath,
    mutation: prepared.mutation,
    intentId,
    operationId,
    originalSha256: prepared.originalSha256,
    postimageSha256: prepared.postimageSha256
  }
  const input = {
    sessionId: context.sessionId,
    requestId: `interrupt-mutation-${context.runId}`,
    actorId: context.actorId,
    expectedVersion: prepared.session.version,
    occurredAt: context.createdAt + 5,
    sessionOwner: context.sessionOwner,
    sessionFencingToken: 1,
    workspaceOwner: context.workspaceOwner,
    workspaceFencingToken: prepared.workspaceLease.fencingToken,
    intentId,
    operationId,
    request: prepared.mutation
  }
  if (request.name === 'abort-after-mutation-preimage') {
    const editor = new SessionEditorService(context.database, {
      artifactRoot: context.preimageArtifactRoot,
      forbiddenRoots: [context.repositoryRoot]
    })
    const retain = editor.preimages.retain.bind(editor.preimages)
    editor.preimages.retain = preimage => {
      const artifact = retain(preimage)
      checkpoint(request.statePath, state, {
        ...common,
        checkpoint: 'MUTATION_PREIMAGE_RETAINED',
        retainedPreimageSha256: artifact.sha256
      })
      process.exit(E3_OPERATIONAL_PILOT_INTERRUPTION_EXIT_CODE)
    }
    editor.mutate(input)
  } else {
    const editor = new SessionEditorService(context.database, {
      artifactRoot: context.preimageArtifactRoot,
      forbiddenRoots: [context.repositoryRoot],
      faultInjector(point) {
        if (point !== 'after_filesystem_publish') return
        checkpoint(request.statePath, state, {
          ...common,
          checkpoint: 'MUTATION_FILESYSTEM_PUBLISHED'
        })
        process.exit(E3_OPERATIONAL_PILOT_INTERRUPTION_EXIT_CODE)
      }
    })
    editor.mutate(input)
  }
  throw new Error('Mutation interruption was not reached')
}

function worker(requestPath) {
  if (process.env[WORKER_FLAG] !== 'true') {
    throw new Error('Interruption worker is disabled')
  }
  const request = validateRequest(readJson(requestPath))
  const ids = [request.runId, request.sessionId]
  const context = createOperationalPilotCaseContext({
    pilotRoot: request.pilotRoot,
    caseName: 'success',
    baselineCommit: request.baselineCommit,
    repositoryRoot: request.repositoryRoot,
    sourceRepositoryPath: request.sourceRepositoryPath,
    idFactory: () => ids.shift() ?? randomUUID()
  })
  if (resolve(context.caseRoot) !== resolve(request.caseRoot)) {
    throw new Error('Interruption case identity changed')
  }
  const state = baseState(context, request)
  checkpoint(request.statePath, state, {})
  if (
    request.name === 'abort-after-mutation-preimage' ||
    request.name === 'abort-after-published-mutation'
  ) {
    interruptMutation(context, request, state)
  }
  const candidate = prepareOperationalPilotCandidate({ context })
  if (request.name === 'abort-after-candidate-freeze') {
    checkpoint(request.statePath, state, {
      checkpoint: 'CANDIDATE_FROZEN',
      candidate
    })
    process.exit(E3_OPERATIONAL_PILOT_INTERRUPTION_EXIT_CODE)
  }
  if (request.name === 'abort-after-validation-snapshot') {
    runOperationalPilotValidation({
      context,
      candidate,
      manifest: request.manifest,
      runtime: {
        run(plan, snapshot) {
          checkpoint(request.statePath, state, {
            checkpoint: 'VALIDATION_SNAPSHOT_PUBLISHED',
            candidate,
            snapshot,
            interruptedProfileId: plan.profile.id
          })
          process.exit(E3_OPERATIONAL_PILOT_INTERRUPTION_EXIT_CODE)
        }
      }
    })
    throw new Error('Validation interruption was not reached')
  }
  const validation = runOperationalPilotValidation({
    context,
    candidate,
    manifest: request.manifest,
    runtime: fixedRuntime()
  })
  const exported = completeOperationalPilotSuccess({
    context,
    candidate,
    validation
  })
  checkpoint(request.statePath, state, {
    checkpoint: 'EXPORT_COMMITTED',
    candidate,
    exportId: exported.exportId,
    exportSha256: exported.exportSha256
  })
  process.exit(E3_OPERATIONAL_PILOT_INTERRUPTION_EXIT_CODE)
}

function reopen(state) {
  const caseRoot = assertRealDirectory(state.caseRoot, 'Case root')
  if (
    !isContained(state.pilotRoot, caseRoot) ||
    !basename(caseRoot).startsWith('case-success-')
  ) {
    throw new Error('Interruption case root escaped')
  }
  const database = openEditorDatabase({ databasePath: state.databasePath })
  const sessions = new EditorRepository(database)
  const workspaceManager = new WorkspaceManager({
    database,
    storageRoot: state.workspaceStorageRoot,
    sourceRepositoryPath: state.sourceRepositoryPath,
    managerOwner: WORKSPACE_OWNER,
    enabled: true,
    forbiddenRoots: [state.repositoryRoot]
  })
  return {
    actorId: ACTOR,
    baselineCommit: state.baselineCommit,
    candidateArtifactRoot: state.candidateArtifactRoot,
    caseName: 'success',
    caseRoot,
    createdAt: state.createdAt,
    database,
    databasePath: state.databasePath,
    idFactory: randomUUID,
    preimageArtifactRoot: state.preimageArtifactRoot,
    repositoryRoot: state.repositoryRoot,
    runId: state.runId,
    sessionId: state.sessionId,
    sessionOwner: SESSION_OWNER,
    sessions,
    sourceRepositoryPath: state.sourceRepositoryPath,
    validationOutputRoot: state.validationOutputRoot,
    validationSnapshotRoot: state.validationSnapshotRoot,
    workspaceManager,
    workspaceOwner: WORKSPACE_OWNER,
    workspaceStorageRoot: state.workspaceStorageRoot
  }
}

function closeAndRemove(context) {
  if (context.database.open) context.database.close()
  if (existsSync(context.caseRoot)) {
    const stat = lstatSync(context.caseRoot)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('Interruption cleanup target is unsafe')
    }
    rmSync(context.caseRoot, { recursive: true, force: false })
  }
}

function recoverMutation(context, state) {
  const editor = new SessionEditorService(context.database, {
    artifactRoot: context.preimageArtifactRoot,
    forbiddenRoots: [context.repositoryRoot]
  })
  if (editor.intents.get(state.intentId)?.state !== 'PREPARED') {
    throw new Error('Interrupted intent is not PREPARED')
  }
  const target = resolve(state.workspacePath, state.mutation.path)
  const expectedBefore = state.interruptionCase ===
    'abort-after-mutation-preimage'
    ? state.originalSha256
    : state.postimageSha256
  if (sha256(readFileSync(target)) !== expectedBefore) {
    throw new Error('Interrupted mutation bytes changed')
  }
  const first = editor.recoverMutation({
    intentId: state.intentId,
    request: state.mutation,
    occurredAt: state.createdAt + 1_000
  })
  const replay = editor.recoverMutation({
    intentId: state.intentId,
    request: state.mutation,
    occurredAt: state.createdAt + 1_001
  })
  const counts = {
    operations: context.database.prepare(
      'SELECT COUNT(*) AS count FROM editor_operations'
    ).get().count,
    preimages: context.database.prepare(
      'SELECT COUNT(*) AS count FROM editor_operation_preimages'
    ).get().count
  }
  if (
    editor.intents.get(state.intentId)?.state !== 'RECORDED' ||
    sha256(readFileSync(target)) !== state.postimageSha256 ||
    replay.replayed !== true ||
    counts.operations !== 1 ||
    counts.preimages !== 1
  ) {
    throw new Error('Mutation recovery is not idempotent')
  }
  return {
    recoveryDecision: 'MUTATION_RECORDED',
    sessionEndState: first.session.status,
    replayVerified: true,
    databaseCounts: counts
  }
}

function verifyCandidate(context, state) {
  const row = context.database.prepare(`
    SELECT * FROM editor_candidate_artifact_sets WHERE id = ?
  `).get(state.candidate.candidateId)
  const store = new ArtifactStore(context.candidateArtifactRoot)
  if (
    !row ||
    row.session_id !== context.sessionId ||
    store.read(row.candidate_manifest_sha256).length === 0 ||
    store.read(row.forward_patch_sha256).length === 0 ||
    store.read(row.reverse_patch_sha256).length === 0 ||
    context.sessions.getSession(context.sessionId)?.status !==
      E3_SESSION_STATUS.EDITING
  ) {
    throw new Error('Frozen candidate did not survive restart')
  }
  const secondRead = store.read(row.candidate_manifest_sha256)
  if (sha256(secondRead) !== row.candidate_manifest_sha256) {
    throw new Error('Frozen candidate replay changed bytes')
  }
  return {
    recoveryDecision: 'CANDIDATE_DURABILITY_VERIFIED',
    sessionEndState: E3_SESSION_STATUS.EDITING,
    replayVerified: true,
    candidateId: row.id,
    candidateManifestSha256: row.candidate_manifest_sha256
  }
}

function recoverSnapshot(context, state) {
  let session = context.sessions.getSession(context.sessionId)
  if (session?.status !== E3_SESSION_STATUS.VALIDATING) {
    throw new Error('Snapshot interruption is not VALIDATING')
  }
  const candidate = context.database.prepare(`
    SELECT * FROM editor_candidate_artifact_sets WHERE id = ?
  `).get(state.candidate.candidateId)
  const manifestBytes = new ArtifactStore(
    context.candidateArtifactRoot
  ).read(candidate.candidate_manifest_sha256)
  const layout = context.workspaceManager.prepareStorage()
  const materializer = new ValidationSnapshotMaterializer({
    snapshotRoot: context.validationSnapshotRoot,
    mirrorPath: layout.mirrorPath,
    forbiddenRoots: [context.repositoryRoot]
  })
  materializer.verify(state.snapshot, manifestBytes)
  materializer.remove(state.snapshot)
  materializer.remove(state.snapshot)
  if (
    existsSync(state.snapshot.path) ||
    (existsSync(context.validationSnapshotRoot) &&
      readdirSync(context.validationSnapshotRoot).length !== 0)
  ) {
    throw new Error('Snapshot cleanup is not idempotent')
  }
  session = context.sessions.transitionSession({
    type: E3_SESSION_COMMAND.START_RECOVERY,
    sessionId: context.sessionId,
    expectedVersion: session.version,
    actorId: context.actorId,
    requestId: `interrupt-recovery-start-${context.runId}`,
    occurredAt: context.createdAt + 1_000,
    leaseOwner: context.sessionOwner,
    fencingToken: 1
  }).session
  session = context.sessions.transitionSession({
    type: E3_SESSION_COMMAND.FINISH_RECOVERY,
    sessionId: context.sessionId,
    expectedVersion: session.version,
    actorId: context.actorId,
    requestId: `interrupt-recovery-finish-${context.runId}`,
    occurredAt: context.createdAt + 1_001,
    leaseOwner: context.sessionOwner,
    fencingToken: 1,
    recoveryStatus: E3_SESSION_STATUS.EDITING
  }).session
  return {
    recoveryDecision: 'SNAPSHOT_REMOVED',
    recoveryTransition: 'VALIDATING->RECOVERING->EDITING',
    sessionEndState: session.status,
    replayVerified: true,
    snapshotCleanupVerified: true
  }
}

function replayExport(context) {
  const row = context.database.prepare(`
    SELECT * FROM editor_pilot_export_records WHERE session_id = ?
  `).get(context.sessionId)
  const replay = new PilotExportService(context.database, {
    artifactRoot: context.candidateArtifactRoot,
    env: { E3_PILOT_EXPORT_ENABLED: 'true' }
  }).exportApproved({
    sessionId: row.session_id,
    expectedVersion: row.approved_session_version,
    approvalId: row.approval_id,
    actorId: row.actor_id,
    requestId: row.request_id,
    occurredAt: row.created_at,
    leaseOwner: SESSION_OWNER,
    fencingToken: 1
  })
  if (replay.replayed !== true) {
    throw new Error('Export replay was not byte-bound')
  }
  return row
}

function recoverExport(context) {
  if (
    context.sessions.getSession(context.sessionId)?.status !==
    E3_SESSION_STATUS.EXPORTED
  ) {
    throw new Error('Export interruption is not EXPORTED')
  }
  const exportRow = replayExport(context)
  const recoveryAt = context.createdAt + LEASE_MS + 10_000
  const cleanupLease = context.sessions.claimLease({
    resourceType: E3_LEASE_RESOURCE_TYPE.CLEANUP,
    resourceKey: 'global',
    owner: RECOVERY_OWNER,
    occurredAt: recoveryAt,
    expiresAt: recoveryAt + 120_000
  })
  const service = new RecoveryReaperService({
    database: context.database,
    storageRoot: context.workspaceStorageRoot,
    workspaceManager: new WorkspaceManager({
      database: context.database,
      storageRoot: context.workspaceStorageRoot,
      sourceRepositoryPath: context.sourceRepositoryPath,
      managerOwner: RECOVERY_OWNER,
      enabled: true,
      forbiddenRoots: [context.repositoryRoot]
    }),
    sessionFinalizer: new RecoverySessionFinalizer(context.database),
    enabled: true,
    processInspector: () => false,
    containerInspector: () => false,
    portInspector: () => false,
    now: () => recoveryAt,
    forbiddenRoots: [context.repositoryRoot]
  })
  const input = {
    runId: randomUUID(),
    actorId: context.actorId,
    requestId: `interrupt-recovery-${context.runId}`,
    occurredAt: recoveryAt,
    cleanupLeaseOwner: RECOVERY_OWNER,
    cleanupFencingToken: cleanupLease.fencingToken,
    leaseDurationMs: 120_000
  }
  const first = service.run(input)
  const replay = service.run(input)
  const decision = first.decisions.find(item =>
    item.sessionId === context.sessionId
  )
  const workspaceRoot = resolve(
    context.workspaceStorageRoot,
    'workspaces',
    context.sessionId
  )
  const session = context.sessions.getSession(context.sessionId)
  if (
    first.run.cleanedCount !== 1 ||
    decision?.decision !== E3_RECOVERY_DECISION.CLEANED ||
    decision.reasonCode !== E3_RECOVERY_REASON.EXPORTED_WORKSPACE ||
    replay.replayed !== true ||
    existsSync(workspaceRoot) ||
    session?.status !== E3_SESSION_STATUS.COMPLETED
  ) {
    throw new Error('Export recovery is incomplete')
  }
  return {
    recoveryDecision: decision.decision,
    recoveryReason: decision.reasonCode,
    sessionEndState: session.status,
    exportId: exportRow.id,
    exportSha256: exportRow.package_sha256,
    replayVerified: true,
    workspaceRemoved: true
  }
}

export function recoverOperationalPilotInterruption({ statePath }) {
  const state = validateState(readJson(statePath), statePath)
  const context = reopen(state)
  try {
    let result
    if (
      state.interruptionCase === 'abort-after-mutation-preimage' ||
      state.interruptionCase === 'abort-after-published-mutation'
    ) {
      result = recoverMutation(context, state)
    } else if (state.interruptionCase === 'abort-after-candidate-freeze') {
      result = verifyCandidate(context, state)
    } else if (
      state.interruptionCase === 'abort-after-validation-snapshot'
    ) {
      result = recoverSnapshot(context, state)
    } else {
      result = recoverExport(context)
    }
    closeAndRemove(context)
    if (existsSync(state.caseRoot)) {
      throw new Error('Interruption case root survived cleanup')
    }
    return Object.freeze({
      case: state.interruptionCase,
      actualOutcome: 'PROCESS_ABORT_RECOVERED',
      checkpoint: state.checkpoint,
      ...result,
      cleanup: Object.freeze({ caseRoot: 'removed', database: 'closed' })
    })
  } catch (error) {
    if (context.database.open) context.database.close()
    throw error
  }
}

export function runOperationalPilotInterruptionCase({
  name,
  pilotRoot,
  baselineCommit,
  manifest,
  repositoryRoot,
  sourceRepositoryPath = repositoryRoot,
  nodePath = process.execPath,
  modulePath = fileURLToPath(import.meta.url)
}) {
  if (!E3_OPERATIONAL_PILOT_INTERRUPTION_CASES.includes(name)) {
    throw new Error('Interruption case is not registered')
  }
  assertCommit(baselineCommit)
  const root = assertPilotPathPolicy({ pilotRoot, repositoryRoot })
  mkdirSync(root, { recursive: true, mode: 0o700 })
  chmodSync(root, 0o700)
  assertRealDirectory(root, 'Pilot root')
  const runId = randomUUID()
  const sessionId = randomUUID()
  const caseRoot = resolve(root, `case-success-${runId}`)
  const statePath = resolve(caseRoot, STATE_NAME)
  const requestPath = resolve(root, `interruption-request-${runId}.json`)
  writeDurableJson(requestPath, {
    format: 'echolink-e3-interruption-worker-v1',
    name,
    pilotRoot: root,
    caseRoot,
    statePath,
    repositoryRoot: resolve(repositoryRoot),
    sourceRepositoryPath: resolve(sourceRepositoryPath),
    baselineCommit,
    manifest,
    runId,
    sessionId
  })
  let completed = false
  try {
    const result = spawnSync(
      nodePath,
      [modulePath, '--worker', requestPath],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: '/usr/bin:/bin',
          HOME: repositoryRoot,
          TMPDIR:
            process.env.TMPDIR === '/e3/tmp'
              ? '/e3/tmp'
              : '/tmp',
          LANG: 'C',
          LC_ALL: 'C',
          TZ: 'UTC',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
          GIT_ASKPASS: '/bin/false',
          [WORKER_FLAG]: 'true'
        }
      }
    )
    if (
      result.error ||
      result.signal !== null ||
      result.status !== E3_OPERATIONAL_PILOT_INTERRUPTION_EXIT_CODE
    ) {
      throw new Error(
        `Worker did not stop at checkpoint: ` +
        `${result.error?.message ?? result.signal ?? result.status}`
      )
    }
    if (!existsSync(statePath)) {
      throw new Error('Worker produced no durable interruption state')
    }
    const recovered = recoverOperationalPilotInterruption({ statePath })
    unlinkSync(requestPath)
    completed = true
    return Object.freeze({
      ...recovered,
      workerBoundary: 'independent-node-process',
      workerExitCode: result.status,
      workerStdoutSha256: digest(result.stdout ?? ''),
      workerStderrSha256: digest(result.stderr ?? '')
    })
  } finally {
    if (!completed && existsSync(requestPath)) {
      chmodSync(requestPath, 0o600)
    }
  }
}

const direct = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  : false

if (direct && process.argv[2] === '--worker') {
  try {
    if (process.argv.length !== 4) {
      throw new Error('usage: interruptionPilot.js --worker <request.json>')
    }
    worker(resolve(process.argv[3]))
  } catch (error) {
    process.stderr.write(`${error.name}: ${error.message}\n`)
    process.exitCode = 1
  }
}
