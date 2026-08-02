import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import {
  E3_LEASE_RESOURCE_TYPE,
  E3_SESSION_COMMAND,
  E3_SESSION_STATUS
} from '../core/contracts.js'
import { E3_EDITOR_OPERATION } from '../editor/contracts.js'
import { SessionEditorService } from '../editor/sessionEditorService.js'
import { sha256 } from '../editor/safeTextFilesystem.js'
import { ArtifactStore } from '../artifacts/artifactStore.js'
import { CandidateArtifactService } from '../artifacts/candidateArtifactService.js'
import { openEditorDatabase } from '../persistence/database.js'
import { EditorRepository } from '../persistence/editorRepository.js'
import { WorkspaceManager } from '../workspaces/workspaceManager.js'
import {
  E3_VALIDATION_PROFILE_ID,
  E3_VALIDATION_RUNTIME
} from '../validation/contracts.js'
import { DockerValidationRuntime } from '../validation/dockerRuntime.js'
import {
  DockerUiValidationRuntime
} from '../validation/dockerUiRuntime.js'
import {
  loadValidationImageManifest
} from '../validation/imageManifest.js'
import {
  ValidationProfileRegistry
} from '../validation/profileRegistry.js'
import {
  ValidationSnapshotMaterializer,
  validationSnapshotHandle
} from '../validation/snapshotMaterializer.js'
import { ValidationBroker } from '../validation/validationBroker.js'
import {
  E3_REVIEW_REQUIRED_PROFILES
} from '../review/contracts.js'
import { ValidationEvidenceService } from '../review/validationEvidenceService.js'
import { ReviewGate } from '../review/reviewGate.js'
import { E3_REVIEW_ERROR } from '../review/errors.js'
import {
  E3_APPROVAL_DECISION,
  E3_APPROVAL_POLICY_SHA256,
  E3_APPROVAL_POLICY_VERSION
} from '../approval/contracts.js'
import { ApprovalGate } from '../approval/approvalGate.js'
import { PilotExportService } from '../export/pilotExportService.js'
import { parseDeterministicTar } from '../export/deterministicTar.js'

export const E3_OPERATIONAL_PILOT_CASES = Object.freeze([
  'success',
  'validation-reject',
  'tamper-reject'
])

export const E3_OPERATIONAL_PILOT_PROFILES = Object.freeze([
  'diff:check',
  'syntax:javascript',
  'syntax:json',
  'test:targeted',
  'test:full',
  'build:frontend',
  'sqlite:integrity',
  'playwright:ui'
])

export const CANONICAL_MANIFEST =
  '/var/lib/echolink-e3/validation-images.json'

export const E3_OPERATIONAL_PILOT_SUCCESS_PATH =
  'docs/e3-pilot-success.txt'

export const E3_OPERATIONAL_PILOT_SUCCESS_CONTENT =
  'E3 operational pilot success\n'

export const E3_OPERATIONAL_PILOT_INVALID_PATH =
  'docs/e3-pilot-invalid.txt'

export const E3_OPERATIONAL_PILOT_INVALID_CONTENT =
  'E3 operational pilot invalid \n'

export const E3_OPERATIONAL_PILOT_TAMPER_PATH =
  'docs/e3-pilot-tamper.txt'

export const E3_OPERATIONAL_PILOT_TAMPER_CONTENT =
  'E3 operational pilot tamper\n'

const REPO = '/root/echolink'
const PILOT_PREFIX = 'echolink-e3-operational-pilot-'
const CASE_PREFIX = 'case-'
const SESSION_OWNER = 'e3-pilot-session'
const WORKSPACE_OWNER = 'e3-pilot-workspace'
const ACTOR = 'e3-pilot-operator'
const VALIDATION_OWNER = 'e3-pilot-validation'
const LEASE_MS = 60 * 60 * 1_000
const GIT = '/usr/bin/git'

function isContainedChild(root, candidate) {
  const relation = relative(root, candidate)
  return (
    relation !== '' &&
    relation !== '..' &&
    !relation.startsWith(`..${sep}`) &&
    !relation.startsWith('../')
  )
}

function assertFullCommit(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error('Operational pilot requires a full Git commit')
  }
  return value
}

function assertRealDirectory(path, label) {
  const metadata = lstatSync(path)
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    realpathSync(path) !== resolve(path)
  ) {
    throw new Error(`${label} must be a canonical real directory`)
  }
}

function fixedGit(cwd, args) {
  return execFileSync(GIT, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: '/usr/bin:/bin',
      HOME: cwd,
      LC_ALL: 'C',
      LANG: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '/bin/false'
    }
  }).trim()
}

export function parseOperationalPilotArgs(argv = []) {
  if (argv.length === 0) return [...E3_OPERATIONAL_PILOT_CASES]
  if (
    argv.length !== 2 ||
    argv[0] !== '--case' ||
    !E3_OPERATIONAL_PILOT_CASES.includes(argv[1])
  ) {
    throw new Error(
      'usage: e3:pilot [--case success|validation-reject|tamper-reject]'
    )
  }
  return [argv[1]]
}

export function assertPilotPathPolicy({
  pilotRoot,
  repositoryRoot = REPO
}) {
  const root = resolve(pilotRoot)
  const repo = resolve(repositoryRoot)
  const rootToRepo = relative(root, repo)
  const repoToRoot = relative(repo, root)
  const overlaps = (
    root === repo ||
    rootToRepo === '' ||
    repoToRoot === '' ||
    (!rootToRepo.startsWith(`..${sep}`) && rootToRepo !== '..') ||
    (!repoToRoot.startsWith(`..${sep}`) && repoToRoot !== '..')
  )
  if (
    root === '/' ||
    overlaps ||
    !basename(root).startsWith(PILOT_PREFIX)
  ) {
    throw new Error(
      'Pilot directory must be private, uniquely named and outside the repository'
    )
  }
  return root
}

export function readCanonicalPilotManifest({
  manifestPath = CANONICAL_MANIFEST,
  expectedBaseline,
  loadManifest = loadValidationImageManifest
} = {}) {
  if (manifestPath !== CANONICAL_MANIFEST) {
    throw new Error('Only the canonical E3 image manifest is permitted')
  }
  const manifest = loadManifest({ manifestPath })
  if (
    manifest.sourceHead !== expectedBaseline ||
    typeof manifest.manifestSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(manifest.manifestSha256) ||
    !/^sha256:[0-9a-f]{64}$/.test(manifest.nodeImageDigest) ||
    !/^sha256:[0-9a-f]{64}$/.test(manifest.playwrightImageDigest)
  ) {
    throw new Error('Canonical E3 image manifest is not bound to the baseline')
  }
  return Object.freeze({
    manifestSha256: manifest.manifestSha256,
    nodeImageDigest: manifest.nodeImageDigest,
    playwrightImageDigest: manifest.playwrightImageDigest,
    sourceHead: manifest.sourceHead
  })
}

export function createOperationalPilotCaseContext({
  pilotRoot,
  caseName,
  baselineCommit,
  repositoryRoot = REPO,
  sourceRepositoryPath = repositoryRoot,
  now = () => Date.now(),
  idFactory = randomUUID
}) {
  const root = assertPilotPathPolicy({ pilotRoot, repositoryRoot })
  if (!E3_OPERATIONAL_PILOT_CASES.includes(caseName)) {
    throw new Error('Operational pilot case is not registered')
  }
  assertFullCommit(baselineCommit)
  assertRealDirectory(root, 'Pilot root')

  const source = realpathSync(sourceRepositoryPath)
  assertRealDirectory(source, 'Source repository')
  if (fixedGit(source, ['rev-parse', 'HEAD']) !== baselineCommit) {
    throw new Error('Source repository HEAD does not match the pilot baseline')
  }
  fixedGit(source, ['cat-file', '-e', `${baselineCommit}^{commit}`])

  const runId = idFactory()
  const sessionId = idFactory()
  const caseRoot = resolve(root, `${CASE_PREFIX}${caseName}-${runId}`)
  if (!isContainedChild(root, caseRoot)) {
    throw new Error('Pilot case directory escaped the pilot root')
  }

  mkdirSync(caseRoot, { recursive: false, mode: 0o700 })
  chmodSync(caseRoot, 0o700)
  assertRealDirectory(caseRoot, 'Pilot case root')

  const databasePath = join(caseRoot, 'editor.db')
  const workspaceStorageRoot = join(caseRoot, 'workspace-storage')
  const preimageArtifactRoot = join(caseRoot, 'preimages')
  const candidateArtifactRoot = join(caseRoot, 'candidate-artifacts')
  const validationSnapshotRoot = join(caseRoot, 'validation-snapshots')
  const validationOutputRoot = join(caseRoot, 'validation-output')
  const createdAt = now()
  const database = openEditorDatabase({ databasePath })
  const sessions = new EditorRepository(database)
  const workspaceManager = new WorkspaceManager({
    database,
    storageRoot: workspaceStorageRoot,
    sourceRepositoryPath: source,
    managerOwner: WORKSPACE_OWNER,
    enabled: true,
    forbiddenRoots: [repositoryRoot]
  })
  let cleaned = false

  function cleanup() {
    if (cleaned) return Object.freeze({ removed: false, alreadyAbsent: true })
    if (database.open) database.close()
    const resolvedCase = resolve(caseRoot)
    if (
      !isContainedChild(root, resolvedCase) ||
      !basename(resolvedCase).startsWith(`${CASE_PREFIX}${caseName}-`)
    ) {
      throw new Error('Pilot cleanup path identity changed')
    }
    if (existsSync(resolvedCase)) {
      const metadata = lstatSync(resolvedCase)
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error('Pilot cleanup target is unsafe')
      }
      rmSync(resolvedCase, { recursive: true, force: false })
    }
    cleaned = true
    return Object.freeze({ removed: true, alreadyAbsent: false })
  }

  return Object.freeze({
    actorId: ACTOR,
    baselineCommit,
    candidateArtifactRoot,
    caseName,
    caseRoot,
    cleanup,
    createdAt,
    database,
    databasePath,
    preimageArtifactRoot,
    repositoryRoot: resolve(repositoryRoot),
    idFactory,
    runId,
    sessionId,
    sessionOwner: SESSION_OWNER,
    sessions,
    sourceRepositoryPath: source,
    workspaceManager,
    validationOutputRoot,
    validationSnapshotRoot,
    workspaceOwner: WORKSPACE_OWNER,
    workspaceStorageRoot
  })
}

function candidateSpecification(caseName) {
  if (caseName === 'success') {
    return Object.freeze({
      path: E3_OPERATIONAL_PILOT_SUCCESS_PATH,
      content: E3_OPERATIONAL_PILOT_SUCCESS_CONTENT,
      summary: 'E3 operational pilot success candidate'
    })
  }
  if (caseName === 'validation-reject') {
    return Object.freeze({
      path: E3_OPERATIONAL_PILOT_INVALID_PATH,
      content: E3_OPERATIONAL_PILOT_INVALID_CONTENT,
      summary: 'E3 operational pilot validation rejection candidate'
    })
  }
  if (caseName === 'tamper-reject') {
    return Object.freeze({
      path: E3_OPERATIONAL_PILOT_TAMPER_PATH,
      content: E3_OPERATIONAL_PILOT_TAMPER_CONTENT,
      summary: 'E3 operational pilot tamper rejection candidate'
    })
  }
  throw new Error('Candidate preparation does not support this pilot case')
}

export function prepareOperationalPilotCandidate({ context }) {
  if (!context) {
    throw new Error('Candidate preparation requires a pilot context')
  }
  const specification = candidateSpecification(context.caseName)
  const t = context.createdAt
  const leaseExpiresAt = t + LEASE_MS
  let session = context.sessions.createSession({
    id: context.sessionId,
    baseCommit: context.baselineCommit,
    createdBy: context.actorId,
    requestSummary: specification.summary,
    createdAt: t,
    leaseOwner: context.sessionOwner,
    leaseExpiresAt
  }).session

  session = context.sessions.transitionSession({
    type: E3_SESSION_COMMAND.START_PROVISIONING,
    sessionId: context.sessionId,
    expectedVersion: session.version,
    actorId: context.actorId,
    requestId: `provision-${context.runId}`,
    occurredAt: t + 1,
    leaseOwner: context.sessionOwner,
    fencingToken: 1
  }).session

  const workspaceLease = context.sessions.claimLease({
    resourceType: E3_LEASE_RESOURCE_TYPE.WORKSPACE,
    resourceKey: context.sessionId,
    owner: context.workspaceOwner,
    occurredAt: t + 2,
    expiresAt: leaseExpiresAt
  })

  const provisioned = context.workspaceManager.provisionWorkspace({
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
    requestId: `ready-${context.runId}`,
    occurredAt: t + 4,
    leaseOwner: context.sessionOwner,
    fencingToken: 1
  }).session

  const editor = new SessionEditorService(context.database, {
    artifactRoot: context.preimageArtifactRoot,
    forbiddenRoots: [context.repositoryRoot]
  })
  session = editor.mutate({
    sessionId: context.sessionId,
    requestId: `mutation-${context.runId}`,
    actorId: context.actorId,
    expectedVersion: session.version,
    occurredAt: t + 5,
    sessionOwner: context.sessionOwner,
    sessionFencingToken: 1,
    workspaceOwner: context.workspaceOwner,
    workspaceFencingToken: workspaceLease.fencingToken,
    request: {
      version: 1,
      type: E3_EDITOR_OPERATION.CREATE_FILE,
      path: specification.path,
      content: specification.content
    }
  }).session

  const candidates = new CandidateArtifactService(context.database, {
    artifactRoot: context.candidateArtifactRoot
  })
  const candidate = candidates.create({
    sessionId: context.sessionId,
    expectedVersion: session.version,
    occurredAt: t + 6,
    sessionOwner: context.sessionOwner,
    sessionFencingToken: 1,
    workspaceOwner: context.workspaceOwner,
    workspaceFencingToken: workspaceLease.fencingToken
  })

  const manifestBytes = candidates.store.read(
    candidate.candidate_manifest_sha256
  )
  const forwardPatchBytes = candidates.store.read(
    candidate.forward_patch_sha256
  )
  if (
    sha256(manifestBytes) !== candidate.candidate_manifest_sha256 ||
    sha256(forwardPatchBytes) !== candidate.forward_patch_sha256
  ) {
    throw new Error('Candidate artifact binding verification failed')
  }

  return Object.freeze({
    baseCommit: context.baselineCommit,
    caseName: context.caseName,
    candidateId: candidate.id,
    candidateManifestSha256: candidate.candidate_manifest_sha256,
    forwardPatchSha256: candidate.forward_patch_sha256,
    reversePatchSha256: candidate.reverse_patch_sha256,
    sessionId: context.sessionId,
    sessionState: session.status,
    sessionVersion: session.version,
    treeSha: candidate.tree_sha,
    mutationPath: specification.path,
    workspacePath: provisioned.record.canonicalPath
  })
}


function resolveOperationalPilotCandidate({ context, candidate }) {
  if (
    !candidate ||
    candidate.caseName !== context.caseName ||
    candidate.sessionId !== context.sessionId ||
    candidate.baseCommit !== context.baselineCommit
  ) {
    throw new Error('Pilot candidate identity does not match its case context')
  }
  const record = context.database.prepare(`
    SELECT
      id,
      session_id,
      base_commit,
      candidate_manifest_sha256,
      forward_patch_sha256
    FROM editor_candidate_artifact_sets
    WHERE id = ?
  `).get(candidate.candidateId)
  if (
    !record ||
    record.session_id !== candidate.sessionId ||
    record.base_commit !== candidate.baseCommit ||
    record.candidate_manifest_sha256 !==
      candidate.candidateManifestSha256 ||
    record.forward_patch_sha256 !== candidate.forwardPatchSha256
  ) {
    throw new Error('Pilot candidate database binding changed')
  }
  const store = new ArtifactStore(context.candidateArtifactRoot)
  return Object.freeze({
    id: record.id,
    sessionId: record.session_id,
    baseCommit: record.base_commit,
    candidateManifestSha256:
      record.candidate_manifest_sha256,
    manifestBytes: store.read(record.candidate_manifest_sha256),
    forwardPatch: store.read(record.forward_patch_sha256)
  })
}

function assertExactProfiles(caseName, profiles) {
  const expected = (
    caseName === 'success' ||
    caseName === 'tamper-reject'
  )
    ? E3_OPERATIONAL_PILOT_PROFILES
    : caseName === 'validation-reject'
      ? [E3_VALIDATION_PROFILE_ID.DIFF_CHECK]
      : null
  if (
    !expected ||
    !Array.isArray(profiles) ||
    profiles.length !== expected.length ||
    profiles.some((profileId, index) => profileId !== expected[index]) ||
    new Set(profiles).size !== profiles.length
  ) {
    throw new Error('Pilot validation profile set is not the fixed case policy')
  }
  return Object.freeze([...profiles])
}

function validationRootsClean(context) {
  for (const root of [
    context.validationSnapshotRoot,
    context.validationOutputRoot
  ]) {
    if (existsSync(root) && readdirSync(root).length !== 0) {
      throw new Error('Pilot validation left residual filesystem resources')
    }
  }
  return true
}

export function createOperationalPilotValidationServices({
  context,
  candidate,
  manifest,
  runtime
}) {
  if (
    !manifest ||
    manifest.sourceHead !== context.baselineCommit ||
    !/^[0-9a-f]{64}$/.test(manifest.manifestSha256) ||
    !/^sha256:[0-9a-f]{64}$/.test(manifest.nodeImageDigest) ||
    !/^sha256:[0-9a-f]{64}$/.test(manifest.playwrightImageDigest)
  ) {
    throw new Error('Pilot validation requires the bound canonical manifest')
  }
  const registry = new ValidationProfileRegistry({
    nodeImageDigest: manifest.nodeImageDigest,
    playwrightImageDigest: manifest.playwrightImageDigest
  })
  const layout = context.workspaceManager.prepareStorage()
  const snapshotMaterializer = new ValidationSnapshotMaterializer({
    snapshotRoot: context.validationSnapshotRoot,
    mirrorPath: layout.mirrorPath,
    forbiddenRoots: [context.repositoryRoot]
  })
  const resolvedCandidate = resolveOperationalPilotCandidate({
    context,
    candidate
  })
  let selectedRuntime = runtime
  if (!selectedRuntime) {
    const nodeRuntime = new DockerValidationRuntime({
      outputRoot: context.validationOutputRoot,
      snapshotRoot: context.validationSnapshotRoot
    })
    const uiRuntime = new DockerUiValidationRuntime({
      outputRoot: context.validationOutputRoot,
      snapshotRoot: context.validationSnapshotRoot
    })
    selectedRuntime = Object.freeze({
      run(plan, snapshot) {
        return plan.profile.id === E3_VALIDATION_PROFILE_ID.PLAYWRIGHT_UI
          ? uiRuntime.run(plan, snapshot)
          : nodeRuntime.run(plan, snapshot)
      }
    })
  }
  if (typeof selectedRuntime.run !== 'function') {
    throw new Error('Pilot validation runtime boundary is invalid')
  }
  const broker = new ValidationBroker({
    registry,
    actualRuntimeVersion: E3_VALIDATION_RUNTIME.version,
    snapshotMaterializer,
    runtime: selectedRuntime,
    candidateResolver: ({ candidateSetId, sessionId }) => {
      if (
        candidateSetId !== resolvedCandidate.id ||
        sessionId !== resolvedCandidate.sessionId
      ) {
        throw new Error('Pilot candidate resolver identity mismatch')
      }
      return resolvedCandidate
    },
    env: { E3_VALIDATION_BROKER_ENABLED: 'true' }
  })
  return Object.freeze({
    broker,
    registry,
    resolvedCandidate,
    snapshotMaterializer
  })
}

export function runOperationalPilotValidation({
  context,
  candidate,
  manifest,
  runtime,
  profiles = (
    context?.caseName === 'success' ||
    context?.caseName === 'tamper-reject'
  )
    ? E3_OPERATIONAL_PILOT_PROFILES
    : [E3_VALIDATION_PROFILE_ID.DIFF_CHECK]
}) {
  const selectedProfiles = assertExactProfiles(
    context?.caseName,
    profiles
  )
  const services = createOperationalPilotValidationServices({
    context,
    candidate,
    manifest,
    runtime
  })
  const current = context.sessions.getSession(candidate.sessionId)
  if (
    current?.status !== E3_SESSION_STATUS.EDITING ||
    current.version !== candidate.sessionVersion
  ) {
    throw new Error('Pilot validation requires the current editing candidate')
  }
  const validating = context.sessions.transitionSession({
    type: E3_SESSION_COMMAND.START_VALIDATION,
    sessionId: candidate.sessionId,
    expectedVersion: current.version,
    actorId: context.actorId,
    requestId: `validate-${context.runId}`,
    occurredAt: context.createdAt + 90,
    leaseOwner: context.sessionOwner,
    fencingToken: 1
  }).session
  const evidenceService = new ValidationEvidenceService(
    context.database,
    {
      artifactRoot: context.candidateArtifactRoot,
      idFactory: context.idFactory
    }
  )
  const results = []
  let offset = 100
  for (const profileId of selectedProfiles) {
    const runId = context.idFactory()
    const requestedAt = context.createdAt + offset
    const result = services.broker.run({
      version: 1,
      runId,
      sessionId: candidate.sessionId,
      candidateSetId: candidate.candidateId,
      candidateManifestSha256:
        candidate.candidateManifestSha256,
      snapshotHandle: validationSnapshotHandle(
        candidate.sessionId,
        runId
      ),
      profileId,
      profileVersion: 1,
      profileSetSha256: services.registry.sha256,
      requestedAt,
      leaseOwner: VALIDATION_OWNER,
      fencingToken: 1
    })
    const evidence = evidenceService.record({
      result,
      profileSetVersion: services.registry.version,
      createdAt: requestedAt,
      finishedAt: requestedAt + 1
    })
    results.push(Object.freeze({
      evidenceId: evidence.id,
      profileId: result.profileId,
      status: result.status,
      exitCode: result.exitCode,
      signal: result.signal,
      runId: result.runId,
      sessionId: result.sessionId,
      candidateSetId: result.candidateSetId,
      candidateManifestSha256:
        result.candidateManifestSha256,
      profileVersion: result.profileVersion,
      profileSha256: result.profileSha256,
      profileSetVersion: result.profileSetVersion,
      profileSetSha256: result.profileSetSha256,
      requestSha256: result.requestSha256,
      planSha256: result.planSha256,
      stdout: result.stdout,
      stderr: result.stderr,
      outputBytes: result.outputBytes
    }))
    offset += 10
  }
  validationRootsClean(context)
  if (
    (
      context.caseName === 'success' ||
      context.caseName === 'tamper-reject'
    ) &&
    results.some(result => result.status !== 'succeeded')
  ) {
    throw new Error('Successful pilot candidate failed validation')
  }
  if (
    context.caseName === 'validation-reject' &&
    (
      results.length !== 1 ||
      results[0].profileId !== E3_VALIDATION_PROFILE_ID.DIFF_CHECK ||
      results[0].status !== 'failed'
    )
  ) {
    throw new Error('Validation rejection case did not fail diff:check')
  }
  return Object.freeze({
    case: context.caseName,
    actualOutcome: context.caseName === 'validation-reject'
      ? 'VALIDATION_REJECTED'
      : 'VALIDATED',
    candidateId: candidate.candidateId,
    profileSetVersion: services.registry.version,
    profileSetSha256: services.registry.sha256,
    sessionState: validating.status,
    sessionVersion: validating.version,
    profiles: Object.freeze(results),
    cleanup: Object.freeze({
      snapshots: 'verified',
      outputs: 'verified'
    })
  })
}

function exactSuccessEvidence(validation) {
  if (
    validation?.actualOutcome !== 'VALIDATED' ||
    validation.sessionState !== E3_SESSION_STATUS.VALIDATING ||
    validation.profiles?.length !== E3_REVIEW_REQUIRED_PROFILES.length ||
    validation.profiles.some((item, index) =>
      item.profileId !== E3_REVIEW_REQUIRED_PROFILES[index] ||
      item.status !== 'succeeded' ||
      typeof item.evidenceId !== 'string'
    )
  ) {
    throw new Error('Pilot success completion requires all fixed evidence')
  }
  return validation.profiles.map(item => item.evidenceId)
}

function verifyOperationalPilotExport({
  context,
  candidate,
  review,
  approval,
  exported
}) {
  const store = new ArtifactStore(context.candidateArtifactRoot)
  const packageBytes = store.read(exported.export.packageSha256)
  const entries = new Map(
    parseDeterministicTar(packageBytes)
      .map(entry => [entry.name, entry.content])
  )
  const forwardPatch = entries.get('patches/forward.patch')
  const reversePatch = entries.get('patches/reverse.patch')
  const manifestBytes = entries.get('E3-EXPORT-MANIFEST.json')
  if (!forwardPatch || !reversePatch || !manifestBytes) {
    throw new Error('Pilot export package is missing required proof bytes')
  }
  if (
    sha256(forwardPatch) !== candidate.forwardPatchSha256 ||
    sha256(reversePatch) !== candidate.reversePatchSha256
  ) {
    throw new Error('Pilot export patch hashes changed')
  }
  const exportManifest = JSON.parse(manifestBytes.toString('utf8'))
  if (
    exportManifest.sessionId !== candidate.sessionId ||
    exportManifest.baseCommit !== candidate.baseCommit ||
    exportManifest.reviewSetId !== review.review.id ||
    exportManifest.approvalId !== approval.approval.id ||
    exportManifest.packageSha256 !== undefined ||
    exportManifest.forwardPatchSha256 !== candidate.forwardPatchSha256 ||
    exportManifest.reversePatchSha256 !== candidate.reversePatchSha256
  ) {
    throw new Error('Pilot export manifest binding changed')
  }

  const layout = context.workspaceManager.prepareStorage()
  const proofRoot = join(context.caseRoot, 'export-proof')
  const forwardPath = join(context.caseRoot, 'forward-proof.patch')
  const reversePath = join(context.caseRoot, 'reverse-proof.patch')
  writeFileSync(forwardPath, forwardPatch, { mode: 0o600 })
  writeFileSync(reversePath, reversePatch, { mode: 0o600 })
  try {
    fixedGit(context.caseRoot, [
      'clone',
      '--no-hardlinks',
      '--no-checkout',
      layout.mirrorPath,
      proofRoot
    ])
    fixedGit(proofRoot, [
      'checkout',
      '--detach',
      candidate.baseCommit
    ])
    const baselineTree = fixedGit(
      proofRoot,
      ['rev-parse', 'HEAD^{tree}']
    )
    fixedGit(proofRoot, ['apply', '--check', forwardPath])
    fixedGit(proofRoot, ['apply', forwardPath])
    fixedGit(proofRoot, ['add', '-A'])
    const forwardTree = fixedGit(proofRoot, ['write-tree'])
    if (forwardTree !== candidate.treeSha) {
      throw new Error('Forward patch did not recreate the candidate tree')
    }
    fixedGit(proofRoot, ['apply', '--check', reversePath])
    fixedGit(proofRoot, ['apply', reversePath])
    fixedGit(proofRoot, ['add', '-A'])
    const reverseTree = fixedGit(proofRoot, ['write-tree'])
    if (reverseTree !== baselineTree) {
      throw new Error('Reverse patch did not restore the baseline tree')
    }
    if (fixedGit(proofRoot, ['status', '--porcelain']) !== '') {
      throw new Error('Patch proof repository is not clean after reversal')
    }
    return Object.freeze({
      baselineTree,
      candidateTree: forwardTree,
      restoredTree: reverseTree,
      forwardPatchSha256: sha256(forwardPatch),
      reversePatchSha256: sha256(reversePatch),
      packageSha256: exported.export.packageSha256
    })
  } finally {
    rmSync(proofRoot, { recursive: true, force: true })
    rmSync(forwardPath, { force: true })
    rmSync(reversePath, { force: true })
  }
}

export function completeOperationalPilotSuccess({
  context,
  candidate,
  validation
}) {
  if (context?.caseName !== 'success') {
    throw new Error('Only the success case can cross the review boundary')
  }
  const evidenceIds = exactSuccessEvidence(validation)
  const current = context.sessions.getSession(candidate.sessionId)
  if (
    current?.status !== E3_SESSION_STATUS.VALIDATING ||
    current.version !== validation.sessionVersion
  ) {
    throw new Error('Pilot review requires the current validating session')
  }
  const review = new ReviewGate(context.database, {
    artifactRoot: context.candidateArtifactRoot,
    env: { E3_REVIEW_GATE_ENABLED: 'true' },
    idFactory: context.idFactory
  }).markReady({
    sessionId: candidate.sessionId,
    expectedVersion: current.version,
    candidateSetId: candidate.candidateId,
    validationEvidenceIds: evidenceIds,
    actorId: context.actorId,
    requestId: `review-${context.runId}`,
    occurredAt: context.createdAt + 300,
    leaseOwner: context.sessionOwner,
    fencingToken: 1
  })

  const approvalOccurredAt = context.createdAt + 400
  const statement = {
    version: 1,
    decision: E3_APPROVAL_DECISION.APPROVE,
    sessionId: candidate.sessionId,
    baseCommit: candidate.baseCommit,
    sessionVersion: review.session.version,
    reviewSetId: review.review.id,
    candidateSetId: candidate.candidateId,
    candidateManifestSha256:
      review.review.candidateManifestSha256,
    forwardPatchSha256: review.review.forwardPatchSha256,
    validationManifestSha256:
      review.review.validationManifestSha256,
    reviewSummarySha256: review.review.reviewSummarySha256,
    pathPolicyVersion: review.review.pathPolicyVersion,
    profileSetVersion: review.review.profileSetVersion,
    profileSetSha256: review.review.profileSetSha256,
    reviewPolicyVersion: review.review.reviewPolicyVersion,
    reviewPolicySha256: review.review.reviewPolicySha256,
    approvalPolicyVersion: E3_APPROVAL_POLICY_VERSION,
    approvalPolicySha256: E3_APPROVAL_POLICY_SHA256,
    actorId: context.actorId,
    occurredAt: approvalOccurredAt
  }
  const approval = new ApprovalGate(context.database, {
    artifactRoot: context.candidateArtifactRoot,
    env: { E3_APPROVAL_GATE_ENABLED: 'true' },
    idFactory: context.idFactory
  }).approve({
    sessionId: candidate.sessionId,
    expectedVersion: review.session.version,
    reviewSetId: review.review.id,
    actorId: context.actorId,
    requestId: `approval-${context.runId}`,
    occurredAt: approvalOccurredAt,
    leaseOwner: context.sessionOwner,
    fencingToken: 1,
    statement
  })
  const exported = new PilotExportService(context.database, {
    artifactRoot: context.candidateArtifactRoot,
    env: { E3_PILOT_EXPORT_ENABLED: 'true' },
    idFactory: context.idFactory
  }).exportApproved({
    sessionId: candidate.sessionId,
    expectedVersion: approval.session.version,
    approvalId: approval.approval.id,
    actorId: context.actorId,
    requestId: `export-${context.runId}`,
    occurredAt: context.createdAt + 500,
    leaseOwner: context.sessionOwner,
    fencingToken: 1
  })
  const patchProof = verifyOperationalPilotExport({
    context,
    candidate,
    review,
    approval,
    exported
  })
  return Object.freeze({
    case: context.caseName,
    actualOutcome: 'EXPORTED',
    sessionEndState: exported.session.status,
    sessionVersion: exported.session.version,
    candidateId: candidate.candidateId,
    reviewCreated: true,
    reviewId: review.review.id,
    validationManifestSha256:
      review.review.validationManifestSha256,
    reviewSummarySha256: review.review.reviewSummarySha256,
    approvalCreated: true,
    approvalId: approval.approval.id,
    approvalStatementSha256: approval.approval.statementSha256,
    exportCreated: true,
    exportId: exported.export.id,
    exportSha256: exported.export.packageSha256,
    profiles: validation.profiles,
    patchProof,
    cleanup: validation.cleanup
  })
}

export function completeOperationalPilotTamperReject({
  context,
  candidate,
  validation
}) {
  if (context?.caseName !== 'tamper-reject') {
    throw new Error('Only the tamper-reject case can execute tamper proof')
  }
  const evidenceIds = exactSuccessEvidence(validation)
  const current = context.sessions.getSession(candidate.sessionId)
  if (
    current?.status !== E3_SESSION_STATUS.VALIDATING ||
    current.version !== validation.sessionVersion
  ) {
    throw new Error('Pilot tamper proof requires the current validating session')
  }
  const artifact = context.database.prepare(`
    SELECT a.storage_key, a.sha256
    FROM editor_candidate_artifact_sets c
    JOIN editor_artifacts a
      ON a.id = c.candidate_manifest_artifact_id
    WHERE c.id = ?
  `).get(candidate.candidateId)
  if (
    !artifact ||
    artifact.sha256 !== candidate.candidateManifestSha256 ||
    typeof artifact.storage_key !== 'string'
  ) {
    throw new Error('Pilot tamper target binding is invalid')
  }
  const artifactRoot = resolve(context.candidateArtifactRoot)
  const artifactPath = resolve(artifactRoot, artifact.storage_key)
  if (!isContainedChild(artifactRoot, artifactPath)) {
    throw new Error('Pilot tamper target escaped the artifact root')
  }
  writeFileSync(artifactPath, 'tampered\n', { flag: 'w' })

  let rejection
  try {
    new ReviewGate(context.database, {
      artifactRoot: context.candidateArtifactRoot,
      env: { E3_REVIEW_GATE_ENABLED: 'true' },
      idFactory: context.idFactory
    }).markReady({
      sessionId: candidate.sessionId,
      expectedVersion: current.version,
      candidateSetId: candidate.candidateId,
      validationEvidenceIds: evidenceIds,
      actorId: context.actorId,
      requestId: `tamper-review-${context.runId}`,
      occurredAt: context.createdAt + 300,
      leaseOwner: context.sessionOwner,
      fencingToken: 1
    })
  } catch (error) {
    rejection = error
  }
  if (
    !rejection ||
    rejection.code !== E3_REVIEW_ERROR.ARTIFACT_TAMPERED
  ) {
    throw new Error('Tampered candidate did not fail closed at review')
  }
  const session = context.sessions.getSession(candidate.sessionId)
  const counts = Object.freeze({
    validationEvidence: context.database.prepare(`
      SELECT COUNT(*) AS count FROM editor_validation_evidence
    `).get().count,
    reviewSets: context.database.prepare(`
      SELECT COUNT(*) AS count FROM editor_review_sets
    `).get().count,
    approvalRecords: context.database.prepare(`
      SELECT COUNT(*) AS count FROM editor_approval_records
    `).get().count,
    exportRecords: context.database.prepare(`
      SELECT COUNT(*) AS count FROM editor_pilot_export_records
    `).get().count
  })
  if (
    session.status !== E3_SESSION_STATUS.VALIDATING ||
    session.version !== current.version ||
    counts.validationEvidence !== E3_OPERATIONAL_PILOT_PROFILES.length ||
    counts.reviewSets !== 0 ||
    counts.approvalRecords !== 0 ||
    counts.exportRecords !== 0
  ) {
    throw new Error('Tamper rejection crossed a forbidden boundary')
  }
  return Object.freeze({
    case: context.caseName,
    actualOutcome: 'TAMPER_REJECTED',
    sessionEndState: session.status,
    sessionVersion: session.version,
    candidateId: candidate.candidateId,
    candidateManifestSha256: candidate.candidateManifestSha256,
    tamperedArtifact: 'candidate-manifest',
    tamperedArtifactSha256: artifact.sha256,
    rejectionCode: rejection.code,
    reviewCreated: false,
    approvalCreated: false,
    exportCreated: false,
    databaseCounts: counts,
    profiles: validation.profiles,
    cleanup: validation.cleanup
  })
}


function operationalPilotDatabaseCounts(context) {
  const count = table => context.database.prepare(
    `SELECT COUNT(*) AS count FROM ${table}`
  ).get().count
  return Object.freeze({
    validationEvidence: count('editor_validation_evidence'),
    reviewSets: count('editor_review_sets'),
    approvalRecords: count('editor_approval_records'),
    exportRecords: count('editor_pilot_export_records')
  })
}

function completeOperationalPilotValidationReject({
  context,
  candidate,
  validation
}) {
  if (
    context?.caseName !== 'validation-reject' ||
    validation?.actualOutcome !== 'VALIDATION_REJECTED' ||
    validation.profiles?.length !== 1 ||
    validation.profiles[0].profileId !==
      E3_VALIDATION_PROFILE_ID.DIFF_CHECK ||
    validation.profiles[0].status !== 'failed'
  ) {
    throw new Error('Validation rejection does not match the fixed case policy')
  }
  const session = context.sessions.getSession(candidate.sessionId)
  const databaseCounts = operationalPilotDatabaseCounts(context)
  if (
    session?.status !== E3_SESSION_STATUS.VALIDATING ||
    session.version !== validation.sessionVersion ||
    databaseCounts.validationEvidence !== 1 ||
    databaseCounts.reviewSets !== 0 ||
    databaseCounts.approvalRecords !== 0 ||
    databaseCounts.exportRecords !== 0
  ) {
    throw new Error('Validation rejection crossed a forbidden boundary')
  }
  return Object.freeze({
    case: context.caseName,
    actualOutcome: 'VALIDATION_REJECTED',
    sessionEndState: session.status,
    sessionVersion: session.version,
    candidateId: candidate.candidateId,
    candidateManifestSha256: candidate.candidateManifestSha256,
    rejectionCode: 'DIFF_CHECK_FAILED',
    reviewCreated: false,
    approvalCreated: false,
    exportCreated: false,
    databaseCounts,
    profiles: validation.profiles,
    cleanup: validation.cleanup
  })
}

export function runOperationalPilotCase({
  name,
  baselineCommit,
  manifest,
  pilotRoot,
  repositoryRoot = REPO,
  sourceRepositoryPath = repositoryRoot,
  runtime
}) {
  let context
  try {
    context = createOperationalPilotCaseContext({
      pilotRoot,
      caseName: name,
      baselineCommit,
      repositoryRoot,
      sourceRepositoryPath
    })
    const candidate = prepareOperationalPilotCandidate({ context })
    const validation = runOperationalPilotValidation({
      context,
      candidate,
      manifest,
      runtime
    })
    const result = name === 'success'
      ? completeOperationalPilotSuccess({ context, candidate, validation })
      : name === 'tamper-reject'
        ? completeOperationalPilotTamperReject({
            context,
            candidate,
            validation
          })
        : completeOperationalPilotValidationReject({
            context,
            candidate,
            validation
          })
    const ownedCaseRoot = context.caseRoot
    const cleanupResult = context.cleanup()
    if (existsSync(ownedCaseRoot)) {
      throw new Error('Pilot case root remains after successful cleanup')
    }
    return Object.freeze({
      ...result,
      cleanup: Object.freeze({
        ...result.cleanup,
        caseRoot: cleanupResult.removed ? 'removed' : 'already-absent',
        database: 'closed'
      })
    })
  } catch (error) {
    if (context?.caseRoot) {
      Object.defineProperty(error, 'pilotDiagnosticCase', {
        value: basename(context.caseRoot),
        enumerable: false,
        configurable: false
      })
    }
    throw error
  }
}

export function createOperationalPilotAdapter({
  repositoryRoot = REPO,
  sourceRepositoryPath = repositoryRoot,
  runtimeFactory
} = {}) {
  if (
    runtimeFactory !== undefined &&
    typeof runtimeFactory !== 'function'
  ) {
    throw new Error('Pilot runtime factory must be a function')
  }
  return Object.freeze({
    async runCase({ name, baselineCommit, manifest, pilotRoot }) {
      const runtime = runtimeFactory
        ? runtimeFactory({ name, baselineCommit, manifest })
        : undefined
      return runOperationalPilotCase({
        name,
        baselineCommit,
        manifest,
        pilotRoot,
        repositoryRoot,
        sourceRepositoryPath,
        runtime
      })
    }
  })
}

function summarizeProfiles(profiles = []) {
  return profiles.map(profile => Object.freeze({
    profileId: profile.profileId,
    status: profile.status,
    exitCode: profile.exitCode ?? null,
    evidenceId: profile.evidenceId ?? null,
    planSha256: profile.planSha256 ?? null
  }))
}

function summarizeCaseResult(name, result) {
  return Object.freeze({
    name,
    expectedOutcome: expectedOutcome(name),
    actualOutcome: result.actualOutcome,
    sessionEndState: result.sessionEndState ?? null,
    candidateId: result.candidateId ?? null,
    candidateManifestSha256:
      result.candidateManifestSha256 ?? null,
    rejectionCode: result.rejectionCode ?? null,
    reviewCreated: result.reviewCreated ?? false,
    reviewId: result.reviewId ?? null,
    validationManifestSha256:
      result.validationManifestSha256 ?? null,
    reviewSummarySha256: result.reviewSummarySha256 ?? null,
    approvalCreated: result.approvalCreated ?? false,
    approvalId: result.approvalId ?? null,
    approvalStatementSha256:
      result.approvalStatementSha256 ?? null,
    exportCreated: result.exportCreated ?? false,
    exportId: result.exportId ?? null,
    exportSha256: result.exportSha256 ?? null,
    tamperedArtifact: result.tamperedArtifact ?? null,
    patchProof: result.patchProof ?? null,
    databaseCounts: result.databaseCounts ?? null,
    profiles: summarizeProfiles(result.profiles),
    cleanup: result.cleanup ?? null
  })
}

function expectedOutcome(name) {
  if (name === 'success') return 'EXPORTED'
  if (name === 'tamper-reject') return 'TAMPER_REJECTED'
  return 'VALIDATION_REJECTED'
}

function verifyCase(name, result) {
  if (
    !result ||
    result.case !== name ||
    result.actualOutcome !== expectedOutcome(name)
  ) {
    throw new Error(`Pilot case ${name} returned an unexpected outcome`)
  }
  if (
    name === 'success' &&
    (
      result.sessionEndState !== E3_SESSION_STATUS.EXPORTED ||
      !/^[0-9a-f]{64}$/.test(result.exportSha256 ?? '') ||
      !Array.isArray(result.profiles) ||
      result.profiles.length !== E3_OPERATIONAL_PILOT_PROFILES.length ||
      result.profiles.some(item => item.status !== 'succeeded') ||
      result.patchProof?.candidateTree === undefined ||
      result.patchProof?.baselineTree !== result.patchProof?.restoredTree
    )
  ) {
    throw new Error('Successful pilot case is incomplete')
  }
  if (
    name === 'validation-reject' &&
    (
      result.sessionEndState !== E3_SESSION_STATUS.VALIDATING ||
      result.rejectionCode !== 'DIFF_CHECK_FAILED' ||
      result.profiles?.length !== 1 ||
      result.profiles[0].profileId !== E3_VALIDATION_PROFILE_ID.DIFF_CHECK ||
      result.profiles[0].status !== 'failed'
    )
  ) {
    throw new Error('Validation rejection case is incomplete')
  }
  if (
    name === 'tamper-reject' &&
    (
      result.sessionEndState !== E3_SESSION_STATUS.VALIDATING ||
      result.rejectionCode !== E3_REVIEW_ERROR.ARTIFACT_TAMPERED ||
      result.tamperedArtifact !== 'candidate-manifest' ||
      result.profiles?.length !== E3_OPERATIONAL_PILOT_PROFILES.length ||
      result.profiles.some(item => item.status !== 'succeeded')
    )
  ) {
    throw new Error('Tamper rejection case is incomplete')
  }
  if (
    name !== 'success' &&
    (
      result.reviewCreated ||
      result.approvalCreated ||
      result.exportCreated ||
      result.sessionEndState === E3_SESSION_STATUS.EXPORTED
    )
  ) {
    throw new Error(`Rejected pilot case crossed a forbidden boundary: ${name}`)
  }
  if (
    result.cleanup?.snapshots !== 'verified' ||
    result.cleanup?.outputs !== 'verified' ||
    result.cleanup?.caseRoot !== 'removed' ||
    result.cleanup?.database !== 'closed'
  ) {
    throw new Error(`Pilot case cleanup is incomplete: ${name}`)
  }
  return result
}

export async function runOperationalPilot({
  cases = E3_OPERATIONAL_PILOT_CASES,
  pilotRoot,
  baselineCommit,
  manifestPath = CANONICAL_MANIFEST,
  manifest,
  adapters,
  repositoryRoot = REPO,
  now = () => new Date().toISOString(),
  fsApi = { mkdirSync, writeFileSync, chmodSync }
}) {
  if (
    manifestPath !== CANONICAL_MANIFEST ||
    cases.some(name => !E3_OPERATIONAL_PILOT_CASES.includes(name))
  ) {
    throw new Error('Operational pilot policy rejected the request')
  }
  const root = assertPilotPathPolicy({ pilotRoot, repositoryRoot })
  if (!manifest || typeof adapters?.runCase !== 'function') {
    throw new Error('Verified manifest and existing E3 service adapter are required')
  }
  fsApi.mkdirSync(root, { recursive: true, mode: 0o700 })
  fsApi.chmodSync(root, 0o700)
  const summary = {
    format: 'echolink-e3-operational-pilot-v1',
    baselineCommit,
    manifestSha256: manifest.manifestSha256,
    imageDigests: {
      node: manifest.nodeImageDigest,
      playwright: manifest.playwrightImageDigest
    },
    cases: [],
    startedAt: now()
  }
  let passed = true
  for (const name of cases) {
    try {
      const result = verifyCase(name, await adapters.runCase({
        name,
        baselineCommit,
        manifest,
        pilotRoot: root,
        profiles: E3_OPERATIONAL_PILOT_PROFILES
      }))
      summary.cases.push(summarizeCaseResult(name, result))
    } catch (error) {
      passed = false
      summary.cases.push({
        name,
        expectedOutcome: expectedOutcome(name),
        actualOutcome: 'FAILED',
        error: error.message,
        diagnosticCase: error.pilotDiagnosticCase ?? null,
        cleanup: 'diagnostic-retained'
      })
      break
    }
  }
  summary.finishedAt = now()
  summary.cleanupStatus = passed ? 'verified' : 'diagnostic-retained'
  summary.result = passed ? 'READY' : 'FAILED'
  const bytes = Buffer.from(`${JSON.stringify(summary, null, 2)}\n`)
  const resultPath = join(root, 'pilot-summary.json')
  fsApi.writeFileSync(resultPath, bytes, { mode: 0o600, flag: 'wx' })
  return Object.freeze({
    ...summary,
    resultPath,
    summarySha256: createHash('sha256').update(bytes).digest('hex')
  })
}
