import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
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
  unlinkSync,
  writeFileSync
} from 'node:fs'
import {
  basename,
  dirname,
  join,
  relative,
  resolve,
  sep
} from 'node:path'
import {
  E3_LEASE_RESOURCE_TYPE,
  E3_SESSION_COMMAND,
  E3_SESSION_STATUS
} from '../core/contracts.js'
import {
  E3_EDITOR_LIMITS,
  E3_EDITOR_OPERATION
} from '../editor/contracts.js'
import { assertEditorPath } from '../editor/pathPolicy.js'
import { SessionEditorService } from '../editor/sessionEditorService.js'
import { sha256 } from '../editor/safeTextFilesystem.js'
import { ArtifactStore } from '../artifacts/artifactStore.js'
import { CandidateArtifactService } from '../artifacts/candidateArtifactService.js'
import { openEditorDatabase } from '../persistence/database.js'
import { EditorRepository } from '../persistence/editorRepository.js'
import { WorkspaceManager } from '../workspaces/workspaceManager.js'
import { acquireManagerLock } from '../workspaces/managerLock.js'
import {
  cleanupTerminalWorkspaceStorage
} from './workspaceStorageCleanup.js'
import {
  E3_VALIDATION_PROFILE_ID,
  E3_VALIDATION_RUNTIME
} from '../validation/contracts.js'
import { DockerValidationRuntime } from '../validation/dockerRuntime.js'
import {
  DockerUiValidationRuntime
} from '../validation/dockerUiRuntime.js'
import {
  DEFAULT_E3_VALIDATION_IMAGE_MANIFEST,
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
import {
  E3_APPROVAL_DECISION,
  E3_APPROVAL_POLICY_SHA256,
  E3_APPROVAL_POLICY_VERSION
} from '../approval/contracts.js'
import { ApprovalGate } from '../approval/approvalGate.js'
import { PilotExportService } from '../export/pilotExportService.js'

export const E3_CHAT_FEATURE_FLAG = 'E3_CHAT_TOOLS_ENABLED'
export const E3_CHAT_STORAGE_ROOT = '/var/lib/echolink-e3/chat'
export const E3_CHAT_REPOSITORY_ROOT = '/root/echolink'
export const E3_CHAT_MANIFEST_PATH =
  DEFAULT_E3_VALIDATION_IMAGE_MANIFEST

export const E3_CHAT_PROFILE_IDS = Object.freeze([
  'diff:check',
  'syntax:javascript',
  'syntax:json',
  'test:targeted',
  'test:full',
  'build:frontend',
  'sqlite:integrity',
  'playwright:ui'
])

export const E3_CHAT_STATUS = Object.freeze({
  PREPARING: 'PREPARING',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  READY_FOR_REVIEW: 'READY_FOR_REVIEW',
  DENIED: 'DENIED',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  QUARANTINE_REQUIRED: 'QUARANTINE_REQUIRED'
})

export const E3_CHAT_ERROR = Object.freeze({
  DISABLED: 'E3_CHAT_DISABLED',
  INVALID_REQUEST: 'E3_CHAT_INVALID_REQUEST',
  BASELINE_UNSAFE: 'E3_CHAT_BASELINE_UNSAFE',
  MANIFEST_STALE: 'E3_CHAT_MANIFEST_STALE',
  NOT_FOUND: 'E3_CHAT_NOT_FOUND',
  FORBIDDEN: 'E3_CHAT_FORBIDDEN',
  STATE_CONFLICT: 'E3_CHAT_STATE_CONFLICT',
  METADATA_TAMPERED: 'E3_CHAT_METADATA_TAMPERED',
  VALIDATION_FAILED: 'E3_CHAT_VALIDATION_FAILED',
  QUARANTINE_REQUIRED: 'E3_CHAT_QUARANTINE_REQUIRED',
  INTERNAL: 'E3_CHAT_INTERNAL'
})

const GIT = '/usr/bin/git'
const SESSION_OWNER = 'e3-chat-session'
const WORKSPACE_OWNER = 'e3-chat-workspace'
const VALIDATION_OWNER = 'e3-chat-validation'
const LEASE_MS = 24 * 60 * 60 * 1000
const MAX_SUMMARY_CHARS = 500
const MAX_OPERATIONS = 20
const MAX_TOTAL_TEXT_BYTES = 1024 * 1024
const MAX_PREVIEW_CHARS = 12_000
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export class E3ChatError extends Error {
  constructor(code, message, details = {}, options = {}) {
    super(message, options)
    this.name = 'E3ChatError'
    this.code = code
    this.details = Object.freeze({ ...details })
  }
}

function fail(code, message, details = {}, cause) {
  throw new E3ChatError(
    code,
    message,
    details,
    cause ? { cause } : {}
  )
}

function exactFields(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(
      E3_CHAT_ERROR.INVALID_REQUEST,
      `${label} must be an object`
    )
  }
  const actual = Object.keys(value).sort()
  const expected = [...fields].sort()
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    fail(
      E3_CHAT_ERROR.INVALID_REQUEST,
      `${label} fields do not match the closed contract`,
      { actual, expected }
    )
  }
}

function assertPositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(
      E3_CHAT_ERROR.INVALID_REQUEST,
      `${field} must be a positive integer`
    )
  }
  return value
}

function assertSessionId(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    fail(
      E3_CHAT_ERROR.INVALID_REQUEST,
      'sessionId must be a canonical UUID'
    )
  }
  return value
}

function actorIdFor(userId) {
  return `echolink-user-${assertPositiveInteger(userId, 'userId')}`
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalJson(value) {
  const canonical = item => {
    if (Array.isArray(item)) return item.map(canonical)
    if (item && typeof item === 'object') {
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map(key => [key, canonical(item[key])])
      )
    }
    return item
  }
  return `${JSON.stringify(canonical(value), null, 2)}\n`
}

function safeGit(cwd, args) {
  try {
    return execFileSync(GIT, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: cwd,
        LANG: 'C',
        LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: '/bin/false'
      }
    }).trim()
  } catch (cause) {
    fail(
      E3_CHAT_ERROR.BASELINE_UNSAFE,
      'Git baseline inspection failed closed',
      { args },
      cause
    )
  }
}

function assertRealDirectory(path, label) {
  let metadata
  try {
    metadata = lstatSync(path)
  } catch (cause) {
    fail(
      E3_CHAT_ERROR.BASELINE_UNSAFE,
      `${label} is unavailable`,
      {},
      cause
    )
  }
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    realpathSync(path) !== resolve(path)
  ) {
    fail(
      E3_CHAT_ERROR.BASELINE_UNSAFE,
      `${label} must be a canonical real directory`
    )
  }
  return path
}

function isContained(root, candidate) {
  const parent = resolve(root)
  const child = resolve(candidate)
  const relation = relative(parent, child)
  return (
    relation !== '' &&
    relation !== '..' &&
    !relation.startsWith(`..${sep}`) &&
    !relation.startsWith('../')
  )
}

function preparePrivateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  chmodSync(path, 0o700)
  const stat = lstatSync(path)
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realpathSync(path) !== resolve(path) ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o777) !== 0o700
  ) {
    fail(
      E3_CHAT_ERROR.METADATA_TAMPERED,
      'E3 chat storage is not a canonical private directory'
    )
  }
  return path
}

function metadataPath(sessionRoot) {
  return join(sessionRoot, 'session.json')
}

function writeAtomicFile(path, bytes, mode = 0o600) {
  const directory = dirname(path)
  preparePrivateDirectory(directory)
  const stage = join(
    directory,
    `.${basename(path)}.stage-${randomUUID()}`
  )
  let descriptor
  try {
    descriptor = openSync(stage, 'wx', mode)
    writeFileSync(descriptor, bytes)
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(stage, path)
    chmodSync(path, mode)
    const directoryDescriptor = openSync(directory, 'r')
    try {
      fsyncSync(directoryDescriptor)
    } finally {
      closeSync(directoryDescriptor)
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    try {
      unlinkSync(stage)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
}

function writeMetadata(sessionRoot, metadata) {
  const unsigned = {
    ...metadata,
    metadataSha256: undefined
  }
  delete unsigned.metadataSha256
  const metadataSha256 = sha256Hex(canonicalJson(unsigned))
  const complete = Object.freeze({
    ...unsigned,
    metadataSha256
  })
  writeAtomicFile(
    metadataPath(sessionRoot),
    canonicalJson(complete),
    0o600
  )
  return complete
}

function readMetadata(sessionRoot) {
  const path = metadataPath(sessionRoot)
  let stat
  let actual
  let bytes
  try {
    stat = lstatSync(path)
    actual = realpathSync(path)
    bytes = readFileSync(path)
  } catch (cause) {
    fail(
      E3_CHAT_ERROR.NOT_FOUND,
      'E3 session metadata does not exist',
      {},
      cause
    )
  }
  if (
    actual !== resolve(path) ||
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.size > 2 * 1024 * 1024
  ) {
    fail(
      E3_CHAT_ERROR.METADATA_TAMPERED,
      'E3 session metadata file is unsafe'
    )
  }
  let metadata
  try {
    metadata = JSON.parse(bytes.toString('utf8'))
  } catch (cause) {
    fail(
      E3_CHAT_ERROR.METADATA_TAMPERED,
      'E3 session metadata is not valid JSON',
      {},
      cause
    )
  }
  const { metadataSha256, ...unsigned } = metadata || {}
  if (
    typeof metadataSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(metadataSha256) ||
    sha256Hex(canonicalJson(unsigned)) !== metadataSha256
  ) {
    fail(
      E3_CHAT_ERROR.METADATA_TAMPERED,
      'E3 session metadata digest does not match'
    )
  }
  return Object.freeze(metadata)
}

function normalizeSummary(value) {
  const summary = String(value || '').trim()
  if (!summary || summary.length > MAX_SUMMARY_CHARS) {
    fail(
      E3_CHAT_ERROR.INVALID_REQUEST,
      `summary must contain 1-${MAX_SUMMARY_CHARS} characters`
    )
  }
  return summary
}

function normalizeOperation(raw, index) {
  const label = `operations[${index}]`
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(E3_CHAT_ERROR.INVALID_REQUEST, `${label} must be an object`)
  }
  const type = raw.type
  if (type === E3_EDITOR_OPERATION.CREATE_FILE) {
    exactFields(raw, ['type', 'path', 'content'], label)
    if (typeof raw.content !== 'string') {
      fail(E3_CHAT_ERROR.INVALID_REQUEST, `${label}.content must be text`)
    }
    assertEditorPath(raw.path, { mutation: true })
    return Object.freeze({
      type,
      path: raw.path,
      content: raw.content
    })
  }
  if (type === E3_EDITOR_OPERATION.REPLACE_EXACT) {
    exactFields(
      raw,
      ['type', 'path', 'search', 'replacement', 'expectedMatches'],
      label
    )
    if (
      typeof raw.search !== 'string' ||
      raw.search.length === 0 ||
      typeof raw.replacement !== 'string'
    ) {
      fail(
        E3_CHAT_ERROR.INVALID_REQUEST,
        `${label} requires non-empty search text and string replacement`
      )
    }
    if (
      !Number.isSafeInteger(raw.expectedMatches) ||
      raw.expectedMatches < 1 ||
      raw.expectedMatches > 100
    ) {
      fail(
        E3_CHAT_ERROR.INVALID_REQUEST,
        `${label}.expectedMatches must be an integer from 1 to 100`
      )
    }
    assertEditorPath(raw.path, { mutation: true })
    return Object.freeze({
      type,
      path: raw.path,
      search: raw.search,
      replacement: raw.replacement,
      expectedMatches: raw.expectedMatches
    })
  }
  fail(
    E3_CHAT_ERROR.INVALID_REQUEST,
    `${label}.type is not admitted by the first Luna bridge`,
    {
      allowed: [
        E3_EDITOR_OPERATION.CREATE_FILE,
        E3_EDITOR_OPERATION.REPLACE_EXACT
      ]
    }
  )
}

export function normalizeE3PrepareRequest(input) {
  exactFields(
    input,
    ['userId', 'conversationId', 'requestId', 'summary', 'operations'],
    'E3 prepare request'
  )
  const userId = assertPositiveInteger(input.userId, 'userId')
  const conversationId = assertPositiveInteger(
    input.conversationId,
    'conversationId'
  )
  const requestId = String(input.requestId || '').trim()
  if (
    requestId.length < 8 ||
    requestId.length > 160 ||
    !/^[A-Za-z0-9._:-]+$/.test(requestId)
  ) {
    fail(
      E3_CHAT_ERROR.INVALID_REQUEST,
      'requestId is invalid'
    )
  }
  if (
    !Array.isArray(input.operations) ||
    input.operations.length < 1 ||
    input.operations.length > MAX_OPERATIONS
  ) {
    fail(
      E3_CHAT_ERROR.INVALID_REQUEST,
      `operations must contain 1-${MAX_OPERATIONS} entries`
    )
  }
  const operations = input.operations.map(normalizeOperation)
  const totalBytes = operations.reduce((sum, operation) => {
    return sum + Buffer.byteLength(
      operation.type === E3_EDITOR_OPERATION.CREATE_FILE
        ? operation.content
        : `${operation.search}\0${operation.replacement}`,
      'utf8'
    )
  }, 0)
  if (
    totalBytes > MAX_TOTAL_TEXT_BYTES ||
    operations.some(operation =>
      operation.type === E3_EDITOR_OPERATION.CREATE_FILE &&
      Buffer.byteLength(operation.content, 'utf8') >
        E3_EDITOR_LIMITS.maxFileBytes
    )
  ) {
    fail(
      E3_CHAT_ERROR.INVALID_REQUEST,
      'E3 prepare request exceeds the bounded text budget'
    )
  }
  return Object.freeze({
    userId,
    conversationId,
    requestId,
    summary: normalizeSummary(input.summary),
    operations: Object.freeze(operations),
    totalBytes
  })
}

function prepareRequestSha256(request) {
  return sha256Hex(canonicalJson({
    version: 1,
    userId: request.userId,
    conversationId: request.conversationId,
    requestId: request.requestId,
    summary: request.summary,
    operations: request.operations
  }))
}


function publicProfile(result) {
  return Object.freeze({
    evidenceId: result.evidenceId,
    profileId: result.profileId,
    status: result.status,
    exitCode: result.exitCode,
    signal: result.signal,
    runId: result.runId,
    profileVersion: result.profileVersion,
    profileSha256: result.profileSha256,
    requestSha256: result.requestSha256,
    planSha256: result.planSha256
  })
}

function defaultRuntimeFactory({ outputRoot, snapshotRoot }) {
  const nodeRuntime = new DockerValidationRuntime({
    outputRoot,
    snapshotRoot
  })
  const uiRuntime = new DockerUiValidationRuntime({
    outputRoot,
    snapshotRoot
  })
  return Object.freeze({
    run(plan, snapshot) {
      return plan.profile.id === E3_VALIDATION_PROFILE_ID.PLAYWRIGHT_UI
        ? uiRuntime.run(plan, snapshot)
        : nodeRuntime.run(plan, snapshot)
    }
  })
}

export class E3ChatSessionService {
  constructor({
    enabled = false,
    storageRoot = E3_CHAT_STORAGE_ROOT,
    repositoryRoot = E3_CHAT_REPOSITORY_ROOT,
    manifestPath = E3_CHAT_MANIFEST_PATH,
    manifestLoader = loadValidationImageManifest,
    runtimeFactory = defaultRuntimeFactory,
    idFactory = randomUUID,
    now = () => Date.now(),
    requireOriginMain = true
  } = {}) {
    this.enabled = enabled === true
    this.storageRoot = resolve(storageRoot)
    this.repositoryRoot = resolve(repositoryRoot)
    this.manifestPath = manifestPath
    this.manifestLoader = manifestLoader
    this.runtimeFactory = runtimeFactory
    this.idFactory = idFactory
    this.now = now
    this.requireOriginMain = requireOriginMain
  }

  #assertEnabled() {
    if (!this.enabled) {
      fail(
        E3_CHAT_ERROR.DISABLED,
        'E3 chat tools are disabled by default'
      )
    }
  }

  #prepareStorage() {
    this.#assertEnabled()
    if (
      this.storageRoot === '/' ||
      this.repositoryRoot === '/' ||
      this.storageRoot === this.repositoryRoot ||
      !isContained(dirname(this.repositoryRoot), this.repositoryRoot)
    ) {
      fail(
        E3_CHAT_ERROR.BASELINE_UNSAFE,
        'E3 chat storage configuration is unsafe'
      )
    }
    const storageToRepo = relative(this.storageRoot, this.repositoryRoot)
    const repoToStorage = relative(this.repositoryRoot, this.storageRoot)
    if (
      storageToRepo === '' ||
      repoToStorage === '' ||
      (!storageToRepo.startsWith('..') || !repoToStorage.startsWith('..'))
    ) {
      fail(
        E3_CHAT_ERROR.BASELINE_UNSAFE,
        'E3 chat storage overlaps the productive repository'
      )
    }
    preparePrivateDirectory(this.storageRoot)
    return this.storageRoot
  }

  #lockPath(key) {
    const locksRoot = resolve(this.storageRoot, 'locks')
    preparePrivateDirectory(locksRoot)
    const lockPath = resolve(locksRoot, `${key}.lock`)
    if (!isContained(locksRoot, lockPath)) {
      fail(
        E3_CHAT_ERROR.METADATA_TAMPERED,
        'E3 lock path escaped its canonical root'
      )
    }
    return lockPath
  }

  #findExistingPrepare(request, requestSha256) {
    const sessionsRoot = resolve(this.storageRoot, 'sessions')
    if (!existsSync(sessionsRoot)) return null
    assertRealDirectory(sessionsRoot, 'E3 sessions root')
    for (const entry of readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (
        !entry.isDirectory() ||
        !UUID_PATTERN.test(entry.name)
      ) {
        continue
      }
      let metadata
      try {
        metadata = readMetadata(join(sessionsRoot, entry.name))
      } catch {
        continue
      }
      if (
        metadata.userId !== request.userId ||
        metadata.conversationId !== request.conversationId ||
        metadata.chatRequestId !== request.requestId
      ) {
        continue
      }
      if (metadata.requestSha256 !== requestSha256) {
        fail(
          E3_CHAT_ERROR.STATE_CONFLICT,
          'E3 chat request ID is already bound to different change bytes',
          { sessionId: metadata.sessionId }
        )
      }
      return metadata
    }
    return null
  }

  #baseline() {
    this.#prepareStorage()
    assertRealDirectory(this.repositoryRoot, 'Productive repository')
    const branch = safeGit(this.repositoryRoot, ['branch', '--show-current'])
    const head = safeGit(this.repositoryRoot, ['rev-parse', 'HEAD'])
    const status = safeGit(this.repositoryRoot, [
      'status',
      '--porcelain',
      '--untracked-files=all'
    ])
    if (
      branch !== 'main' ||
      !/^[0-9a-f]{40}$/.test(head) ||
      status !== ''
    ) {
      fail(
        E3_CHAT_ERROR.BASELINE_UNSAFE,
        'E3 requires clean main at an exact full commit',
        { branch, head, dirty: status !== '' }
      )
    }
    if (this.requireOriginMain) {
      const upstream = safeGit(
        this.repositoryRoot,
        ['rev-parse', 'origin/main']
      )
      if (upstream !== head) {
        fail(
          E3_CHAT_ERROR.BASELINE_UNSAFE,
          'E3 requires main and origin/main to match exactly',
          { head, upstream }
        )
      }
    }
    let manifest
    try {
      manifest = this.manifestLoader({
        manifestPath: this.manifestPath
      })
    } catch (cause) {
      fail(
        E3_CHAT_ERROR.MANIFEST_STALE,
        'The canonical E3 validation manifest is unavailable',
        {},
        cause
      )
    }
    if (
      manifest.sourceHead !== head ||
      !/^[0-9a-f]{64}$/.test(manifest.manifestSha256) ||
      !/^sha256:[0-9a-f]{64}$/.test(manifest.nodeImageDigest) ||
      !/^sha256:[0-9a-f]{64}$/.test(manifest.playwrightImageDigest)
    ) {
      fail(
        E3_CHAT_ERROR.MANIFEST_STALE,
        'Validator images are not bound to the current EchoLink commit',
        {
          head,
          manifestSourceHead: manifest.sourceHead
        }
      )
    }
    return Object.freeze({
      branch,
      head,
      manifest: Object.freeze({
        sourceHead: manifest.sourceHead,
        manifestSha256: manifest.manifestSha256,
        nodeImageDigest: manifest.nodeImageDigest,
        playwrightImageDigest: manifest.playwrightImageDigest
      })
    })
  }

  #sessionRoot(sessionId) {
    assertSessionId(sessionId)
    const root = resolve(this.storageRoot, 'sessions', sessionId)
    const sessionsRoot = resolve(this.storageRoot, 'sessions')
    if (!isContained(sessionsRoot, root)) {
      fail(
        E3_CHAT_ERROR.METADATA_TAMPERED,
        'E3 session path escaped its storage root'
      )
    }
    return root
  }

  #paths(sessionId) {
    const sessionRoot = this.#sessionRoot(sessionId)
    return Object.freeze({
      sessionRoot,
      databasePath: join(sessionRoot, 'editor.db'),
      workspaceStorageRoot: join(sessionRoot, 'workspace-storage'),
      preimageArtifactRoot: join(sessionRoot, 'preimages'),
      candidateArtifactRoot: join(sessionRoot, 'candidate-artifacts'),
      validationSnapshotRoot: join(sessionRoot, 'validation-snapshots'),
      validationOutputRoot: join(sessionRoot, 'validation-output'),
      exportPath: join(sessionRoot, 'export', `e3-export-${sessionId}.tar`)
    })
  }

  #openContext(sessionId, { create = false } = {}) {
    const paths = this.#paths(sessionId)
    if (create) {
      if (existsSync(paths.sessionRoot)) {
        fail(
          E3_CHAT_ERROR.STATE_CONFLICT,
          'E3 session directory already exists'
        )
      }
      preparePrivateDirectory(dirname(paths.sessionRoot))
      mkdirSync(paths.sessionRoot, { mode: 0o700 })
      chmodSync(paths.sessionRoot, 0o700)
    } else {
      assertRealDirectory(paths.sessionRoot, 'E3 session root')
    }
    const database = openEditorDatabase({
      databasePath: paths.databasePath
    })
    const sessions = new EditorRepository(database)
    const workspaceManager = new WorkspaceManager({
      database,
      storageRoot: paths.workspaceStorageRoot,
      sourceRepositoryPath: this.repositoryRoot,
      managerOwner: WORKSPACE_OWNER,
      enabled: true,
      forbiddenRoots: [this.repositoryRoot]
    })
    return {
      ...paths,
      database,
      sessions,
      workspaceManager
    }
  }

  #assertOwner(metadata, userId, conversationId = null) {
    if (
      metadata.userId !== assertPositiveInteger(userId, 'userId') ||
      (
        conversationId !== null &&
        metadata.conversationId !== assertPositiveInteger(
          conversationId,
          'conversationId'
        )
      )
    ) {
      fail(
        E3_CHAT_ERROR.FORBIDDEN,
        'E3 session belongs to another user or conversation'
      )
    }
  }

  #loadOwned(sessionId, userId, conversationId = null) {
    this.#prepareStorage()
    const root = this.#sessionRoot(sessionId)
    const metadata = readMetadata(root)
    if (metadata.sessionId !== sessionId) {
      fail(
        E3_CHAT_ERROR.METADATA_TAMPERED,
        'E3 metadata is bound to another session'
      )
    }
    this.#assertOwner(metadata, userId, conversationId)
    return { root, metadata }
  }

  #resolvedCandidate(context, candidate) {
    const record = context.database.prepare(`
      SELECT
        id,
        session_id,
        base_commit,
        candidate_manifest_sha256,
        forward_patch_sha256
      FROM editor_candidate_artifact_sets
      WHERE id = ?
    `).get(candidate.id)
    if (
      !record ||
      record.session_id !== candidate.sessionId ||
      record.base_commit !== candidate.baseCommit ||
      record.candidate_manifest_sha256 !==
        candidate.candidateManifestSha256 ||
      record.forward_patch_sha256 !== candidate.forwardPatchSha256
    ) {
      fail(
        E3_CHAT_ERROR.METADATA_TAMPERED,
        'Candidate database binding changed'
      )
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

  #validationServices(context, candidate, manifest) {
    const registry = new ValidationProfileRegistry({
      nodeImageDigest: manifest.nodeImageDigest,
      playwrightImageDigest: manifest.playwrightImageDigest
    })
    const layout = context.workspaceManager.prepareStorage()
    const snapshotMaterializer = new ValidationSnapshotMaterializer({
      snapshotRoot: context.validationSnapshotRoot,
      mirrorPath: layout.mirrorPath,
      forbiddenRoots: [this.repositoryRoot]
    })
    const resolvedCandidate = this.#resolvedCandidate(context, candidate)
    const runtime = this.runtimeFactory({
      outputRoot: context.validationOutputRoot,
      snapshotRoot: context.validationSnapshotRoot
    })
    if (!runtime || typeof runtime.run !== 'function') {
      fail(
        E3_CHAT_ERROR.INTERNAL,
        'E3 validation runtime boundary is invalid'
      )
    }
    const broker = new ValidationBroker({
      registry,
      actualRuntimeVersion: E3_VALIDATION_RUNTIME.version,
      snapshotMaterializer,
      runtime,
      candidateResolver: ({ candidateSetId, sessionId }) => {
        if (
          candidateSetId !== resolvedCandidate.id ||
          sessionId !== resolvedCandidate.sessionId
        ) {
          fail(
            E3_CHAT_ERROR.METADATA_TAMPERED,
            'E3 candidate resolver identity mismatch'
          )
        }
        return resolvedCandidate
      },
      env: { E3_VALIDATION_BROKER_ENABLED: 'true' }
    })
    return Object.freeze({
      broker,
      registry,
      snapshotMaterializer
    })
  }

  #assertValidationRootsClean(context) {
    for (const root of [
      context.validationSnapshotRoot,
      context.validationOutputRoot
    ]) {
      if (existsSync(root) && readdirSync(root).length !== 0) {
        fail(
          E3_CHAT_ERROR.QUARANTINE_REQUIRED,
          'Validation left residual filesystem resources',
          { root }
        )
      }
    }
  }

  #runValidation({ context, candidate, manifest, baseTime }) {
    const services = this.#validationServices(
      context,
      candidate,
      manifest
    )
    const current = context.sessions.getSession(candidate.sessionId)
    if (
      current?.status !== E3_SESSION_STATUS.EDITING ||
      current.version !== candidate.sessionVersion
    ) {
      fail(
        E3_CHAT_ERROR.STATE_CONFLICT,
        'Validation requires the current editing candidate'
      )
    }
    let session = context.sessions.transitionSession({
      type: E3_SESSION_COMMAND.START_VALIDATION,
      sessionId: candidate.sessionId,
      expectedVersion: current.version,
      actorId: candidate.actorId,
      requestId: `validate-${candidate.runId}`,
      occurredAt: baseTime + 100,
      leaseOwner: SESSION_OWNER,
      fencingToken: candidate.sessionFencingToken
    }).session
    const evidenceService = new ValidationEvidenceService(
      context.database,
      {
        artifactRoot: context.candidateArtifactRoot,
        idFactory: this.idFactory
      }
    )
    const profiles = []
    let failed = null
    let offset = 110
    for (const profileId of E3_CHAT_PROFILE_IDS) {
      const runId = this.idFactory()
      const requestedAt = baseTime + offset
      const result = services.broker.run({
        version: 1,
        runId,
        sessionId: candidate.sessionId,
        candidateSetId: candidate.id,
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
      const profile = publicProfile({
        ...result,
        evidenceId: evidence.id
      })
      profiles.push(profile)
      if (result.status !== 'succeeded') {
        failed = profile
        break
      }
      offset += 10
    }
    this.#assertValidationRootsClean(context)
    if (failed) {
      session = context.sessions.transitionSession({
        type: E3_SESSION_COMMAND.RECORD_VALIDATION_FAILURE,
        sessionId: candidate.sessionId,
        expectedVersion: session.version,
        actorId: candidate.actorId,
        requestId: `validation-failed-${candidate.runId}`,
        occurredAt: baseTime + 260,
        leaseOwner: SESSION_OWNER,
        fencingToken: candidate.sessionFencingToken,
        failureMessage: `${failed.profileId} failed with exit code ${failed.exitCode}`
      }).session
    }
    return Object.freeze({
      failed,
      profiles: Object.freeze(profiles),
      profileSetVersion: services.registry.version,
      profileSetSha256: services.registry.sha256,
      session
    })
  }

  #review({ context, candidate, validation, baseTime }) {
    if (
      validation.failed ||
      validation.profiles.length !== E3_REVIEW_REQUIRED_PROFILES.length ||
      validation.profiles.some((profile, index) =>
        profile.profileId !== E3_REVIEW_REQUIRED_PROFILES[index] ||
        profile.status !== 'succeeded'
      )
    ) {
      fail(
        E3_CHAT_ERROR.VALIDATION_FAILED,
        'Review requires all fixed validation evidence'
      )
    }
    const current = context.sessions.getSession(candidate.sessionId)
    if (
      current?.status !== E3_SESSION_STATUS.VALIDATING ||
      current.version !== validation.session.version
    ) {
      fail(
        E3_CHAT_ERROR.STATE_CONFLICT,
        'Review requires the current validating session'
      )
    }
    return new ReviewGate(context.database, {
      artifactRoot: context.candidateArtifactRoot,
      env: { E3_REVIEW_GATE_ENABLED: 'true' },
      idFactory: this.idFactory
    }).markReady({
      sessionId: candidate.sessionId,
      expectedVersion: current.version,
      candidateSetId: candidate.id,
      validationEvidenceIds:
        validation.profiles.map(profile => profile.evidenceId),
      actorId: candidate.actorId,
      requestId: `review-${candidate.runId}`,
      occurredAt: baseTime + 300,
      leaseOwner: SESSION_OWNER,
      fencingToken: candidate.sessionFencingToken
    })
  }

  #cleanupWorkspace(context, metadata, occurredAt) {
    const result = context.workspaceManager.removeWorkspace({
      sessionId: metadata.sessionId,
      leaseOwner: WORKSPACE_OWNER,
      fencingToken: metadata.workspaceFencingToken,
      removedAt: occurredAt
    })
    const storage = cleanupTerminalWorkspaceStorage({
      database: context.database,
      sessionId: metadata.sessionId,
      sessionRoot: context.sessionRoot,
      workspaceStorageRoot: context.workspaceStorageRoot
    })
    return Object.freeze({
      removed: result.removed === true,
      alreadyAbsent: result.alreadyAbsent === true,
      storageRemoved: storage.removed === true,
      storageAlreadyAbsent: storage.alreadyAbsent === true,
      storageLogicalBytes: storage.logicalBytes
    })
  }

  #recordPrepareFailure(context, metadata, error) {
    let quarantined = false
    const recovery = {
      sessionCancelled: false,
      workspaceRemoved: false,
      workspaceAlreadyAbsent: false,
      validationRootsClean: false
    }
    try {
      const current = context.sessions.getSession(metadata.sessionId)
      if (current && ![
        E3_SESSION_STATUS.CANCELLED,
        E3_SESSION_STATUS.COMPLETED,
        E3_SESSION_STATUS.FAILED,
        E3_SESSION_STATUS.CONFLICTED
      ].includes(current.status)) {
        context.sessions.transitionSession({
          type: E3_SESSION_COMMAND.CANCEL,
          sessionId: metadata.sessionId,
          expectedVersion: current.version,
          actorId: metadata.actorId,
          requestId: `prepare-failure-${metadata.runId}`,
          occurredAt: this.now(),
          leaseOwner: SESSION_OWNER,
          fencingToken: metadata.sessionFencingToken
        })
        recovery.sessionCancelled = true
      } else if (current?.status === E3_SESSION_STATUS.CANCELLED) {
        recovery.sessionCancelled = true
      }
    } catch {
      quarantined = true
    }
    if (metadata.workspaceFencingToken !== null) {
      try {
        const cleanup = this.#cleanupWorkspace(
          context,
          metadata,
          this.now()
        )
        recovery.workspaceRemoved = cleanup.removed
        recovery.workspaceAlreadyAbsent = cleanup.alreadyAbsent
      } catch {
        quarantined = true
      }
    }
    try {
      this.#assertValidationRootsClean(context)
      recovery.validationRootsClean = true
    } catch {
      quarantined = true
    }
    return writeMetadata(context.sessionRoot, {
      ...metadata,
      status: quarantined
        ? E3_CHAT_STATUS.QUARANTINE_REQUIRED
        : E3_CHAT_STATUS.FAILED,
      updatedAt: this.now(),
      failure: {
        code: error?.code || E3_CHAT_ERROR.INTERNAL,
        message: String(error?.message || error).slice(0, 2000),
        recovery
      }
    })
  }

  prepareChange(input) {
    this.#assertEnabled()
    const request = normalizeE3PrepareRequest(input)
    const requestSha256 = prepareRequestSha256(request)
    this.#prepareStorage()
    const requestLock = acquireManagerLock(
      this.#lockPath(`prepare-${requestSha256}`),
      { owner: `prepare-${request.userId}`, acquiredAt: this.now() }
    )
    let baseline
    let sessionId
    let runId
    let actorId
    let baseTime
    let context
    let metadata
    try {
      const existing = this.#findExistingPrepare(
        request,
        requestSha256
      )
      if (existing) {
        return this.#publicMetadata(existing, {
          replayed: true,
          actionRequired:
            existing.status === E3_CHAT_STATUS.READY_FOR_REVIEW
        })
      }
      baseline = this.#baseline()
      sessionId = this.idFactory()
      runId = this.idFactory()
      assertSessionId(sessionId)
      assertSessionId(runId)
      actorId = actorIdFor(request.userId)
      baseTime = this.now()
      context = this.#openContext(sessionId, { create: true })
      metadata = writeMetadata(context.sessionRoot, {
        version: 1,
        sessionId,
        runId,
        userId: request.userId,
        conversationId: request.conversationId,
        chatRequestId: request.requestId,
        requestSha256,
        summary: request.summary,
        status: E3_CHAT_STATUS.PREPARING,
        baselineCommit: baseline.head,
        manifest: baseline.manifest,
        createdAt: baseTime,
        updatedAt: baseTime,
        actorId,
        sessionFencingToken: 1,
        workspaceFencingToken: null,
        operationCount: request.operations.length,
        operationPaths: request.operations.map(operation => operation.path),
        candidate: null,
        validation: null,
        review: null,
        approvalAttempt: null,
        approval: null,
        export: null,
        failure: null
      })
    } finally {
      requestLock.release()
    }
    try {
      const leaseExpiresAt = baseTime + LEASE_MS
      let session = context.sessions.createSession({
        id: sessionId,
        baseCommit: baseline.head,
        createdBy: actorId,
        requestSummary: request.summary,
        createdAt: baseTime,
        leaseOwner: SESSION_OWNER,
        leaseExpiresAt
      }).session
      session = context.sessions.transitionSession({
        type: E3_SESSION_COMMAND.START_PROVISIONING,
        sessionId,
        expectedVersion: session.version,
        actorId,
        requestId: `provision-${runId}`,
        occurredAt: baseTime + 1,
        leaseOwner: SESSION_OWNER,
        fencingToken: 1
      }).session
      const workspaceLease = context.sessions.claimLease({
        resourceType: E3_LEASE_RESOURCE_TYPE.WORKSPACE,
        resourceKey: sessionId,
        owner: WORKSPACE_OWNER,
        occurredAt: baseTime + 2,
        expiresAt: leaseExpiresAt
      })
      const provisioned = context.workspaceManager.provisionWorkspace({
        sessionId,
        leaseOwner: WORKSPACE_OWNER,
        fencingToken: workspaceLease.fencingToken,
        createdAt: baseTime + 3
      })
      session = context.sessions.transitionSession({
        type: E3_SESSION_COMMAND.FINISH_PROVISIONING,
        sessionId,
        expectedVersion: session.version,
        actorId,
        requestId: `ready-${runId}`,
        occurredAt: baseTime + 4,
        leaseOwner: SESSION_OWNER,
        fencingToken: 1
      }).session
      metadata = writeMetadata(context.sessionRoot, {
        ...metadata,
        workspaceFencingToken: workspaceLease.fencingToken,
        updatedAt: baseTime + 4
      })
      const editor = new SessionEditorService(context.database, {
        artifactRoot: context.preimageArtifactRoot,
        forbiddenRoots: [this.repositoryRoot],
        idFactory: this.idFactory
      })
      for (const [index, operation] of request.operations.entries()) {
        let editorRequest
        if (operation.type === E3_EDITOR_OPERATION.CREATE_FILE) {
          editorRequest = {
            version: 1,
            type: operation.type,
            path: operation.path,
            content: operation.content
          }
        } else {
          const target = resolve(
            provisioned.record.canonicalPath,
            operation.path
          )
          if (!isContained(provisioned.record.canonicalPath, target)) {
            fail(
              E3_CHAT_ERROR.INVALID_REQUEST,
              'Replacement path escaped the workspace'
            )
          }
          editorRequest = {
            version: 1,
            type: operation.type,
            path: operation.path,
            expectedSha256: sha256(readFileSync(target)),
            search: operation.search,
            replacement: operation.replacement,
            expectedMatches: operation.expectedMatches
          }
        }
        session = editor.mutate({
          sessionId,
          requestId: `mutation-${runId}-${index + 1}`,
          actorId,
          expectedVersion: session.version,
          occurredAt: baseTime + 5 + index,
          sessionOwner: SESSION_OWNER,
          sessionFencingToken: 1,
          workspaceOwner: WORKSPACE_OWNER,
          workspaceFencingToken: workspaceLease.fencingToken,
          request: editorRequest
        }).session
      }
      const candidates = new CandidateArtifactService(context.database, {
        artifactRoot: context.candidateArtifactRoot,
        idFactory: this.idFactory
      })
      const record = candidates.create({
        sessionId,
        expectedVersion: session.version,
        occurredAt: baseTime + 40,
        sessionOwner: SESSION_OWNER,
        sessionFencingToken: 1,
        workspaceOwner: WORKSPACE_OWNER,
        workspaceFencingToken: workspaceLease.fencingToken
      })
      const patchBytes = candidates.store.read(record.forward_patch_sha256)
      if (sha256(patchBytes) !== record.forward_patch_sha256) {
        fail(
          E3_CHAT_ERROR.METADATA_TAMPERED,
          'Candidate patch hash changed after publication'
        )
      }
      const candidate = Object.freeze({
        id: record.id,
        sessionId,
        runId,
        actorId,
        baseCommit: baseline.head,
        sessionVersion: session.version,
        sessionFencingToken: 1,
        candidateManifestSha256: record.candidate_manifest_sha256,
        forwardPatchSha256: record.forward_patch_sha256,
        reversePatchSha256: record.reverse_patch_sha256,
        treeSha: record.tree_sha
      })
      const validation = this.#runValidation({
        context,
        candidate,
        manifest: baseline.manifest,
        baseTime
      })
      if (validation.failed) {
        let failedSession = validation.session
        failedSession = context.sessions.transitionSession({
          type: E3_SESSION_COMMAND.CANCEL,
          sessionId,
          expectedVersion: failedSession.version,
          actorId,
          requestId: `cancel-validation-${runId}`,
          occurredAt: baseTime + 270,
          leaseOwner: SESSION_OWNER,
          fencingToken: 1
        }).session
        const cleanup = this.#cleanupWorkspace(
          context,
          {
            sessionId,
            workspaceFencingToken: workspaceLease.fencingToken
          },
          baseTime + 271
        )
        metadata = writeMetadata(context.sessionRoot, {
          ...metadata,
          status: E3_CHAT_STATUS.VALIDATION_FAILED,
          updatedAt: baseTime + 271,
          candidate,
          validation: {
            profileSetVersion: validation.profileSetVersion,
            profileSetSha256: validation.profileSetSha256,
            profiles: validation.profiles,
            failedProfile: validation.failed.profileId
          },
          failure: {
            code: E3_CHAT_ERROR.VALIDATION_FAILED,
            message: `${validation.failed.profileId} failed`,
            cleanup
          }
        })
        return this.#publicMetadata(metadata)
      }
      const reviewResult = this.#review({
        context,
        candidate,
        validation,
        baseTime
      })
      const review = Object.freeze({
        id: reviewResult.review.id,
        sessionVersion: reviewResult.session.version,
        candidateManifestSha256:
          reviewResult.review.candidateManifestSha256,
        forwardPatchSha256:
          reviewResult.review.forwardPatchSha256,
        validationManifestSha256:
          reviewResult.review.validationManifestSha256,
        reviewSummarySha256:
          reviewResult.review.reviewSummarySha256,
        pathPolicyVersion:
          reviewResult.review.pathPolicyVersion,
        profileSetVersion:
          reviewResult.review.profileSetVersion,
        profileSetSha256:
          reviewResult.review.profileSetSha256,
        reviewPolicyVersion:
          reviewResult.review.reviewPolicyVersion,
        reviewPolicySha256:
          reviewResult.review.reviewPolicySha256
      })
      const patchText = patchBytes.toString('utf8')
      metadata = writeMetadata(context.sessionRoot, {
        ...metadata,
        status: E3_CHAT_STATUS.READY_FOR_REVIEW,
        updatedAt: baseTime + 300,
        candidate,
        validation: {
          profileSetVersion: validation.profileSetVersion,
          profileSetSha256: validation.profileSetSha256,
          profiles: validation.profiles,
          failedProfile: null
        },
        review,
        diff: {
          sha256: record.forward_patch_sha256,
          bytes: patchBytes.length,
          preview: patchText.slice(0, MAX_PREVIEW_CHARS),
          truncated: patchText.length > MAX_PREVIEW_CHARS
        }
      })
      return this.#publicMetadata(metadata, { actionRequired: true })
    } catch (error) {
      try {
        metadata = this.#recordPrepareFailure(
          context,
          metadata,
          error
        )
      } catch {}
      throw error
    } finally {
      if (context.database.open) context.database.close()
    }
  }

  #approvalInput(metadata, occurredAt) {
    const review = metadata.review
    const candidate = metadata.candidate
    const statement = Object.freeze({
      version: 1,
      decision: E3_APPROVAL_DECISION.APPROVE,
      sessionId: metadata.sessionId,
      baseCommit: metadata.baselineCommit,
      sessionVersion: review.sessionVersion,
      reviewSetId: review.id,
      candidateSetId: candidate.id,
      candidateManifestSha256:
        review.candidateManifestSha256,
      forwardPatchSha256:
        review.forwardPatchSha256,
      validationManifestSha256:
        review.validationManifestSha256,
      reviewSummarySha256:
        review.reviewSummarySha256,
      pathPolicyVersion: review.pathPolicyVersion,
      profileSetVersion: review.profileSetVersion,
      profileSetSha256: review.profileSetSha256,
      reviewPolicyVersion: review.reviewPolicyVersion,
      reviewPolicySha256: review.reviewPolicySha256,
      approvalPolicyVersion: E3_APPROVAL_POLICY_VERSION,
      approvalPolicySha256: E3_APPROVAL_POLICY_SHA256,
      actorId: metadata.actorId,
      occurredAt
    })
    return Object.freeze({
      sessionId: metadata.sessionId,
      expectedVersion: review.sessionVersion,
      reviewSetId: review.id,
      actorId: metadata.actorId,
      requestId: `approval-${metadata.runId}`,
      occurredAt,
      leaseOwner: SESSION_OWNER,
      fencingToken: metadata.sessionFencingToken,
      statement
    })
  }

  approveChange({ sessionId, userId }) {
    this.#assertEnabled()
    assertSessionId(sessionId)
    this.#prepareStorage()
    const actionLock = acquireManagerLock(
      this.#lockPath(`action-${sessionId}`),
      { owner: `approve-${userId}`, acquiredAt: this.now() }
    )
    try {
      let loaded = this.#loadOwned(sessionId, userId)
      let metadata = loaded.metadata
      if (metadata.status === E3_CHAT_STATUS.COMPLETED) {
        return this.#publicMetadata(metadata, { replayed: true })
      }
      if (metadata.status !== E3_CHAT_STATUS.READY_FOR_REVIEW) {
        fail(
          E3_CHAT_ERROR.STATE_CONFLICT,
          'Only a review-ready E3 session can be approved',
          { status: metadata.status }
        )
      }
      if (!metadata.approvalAttempt) {
        metadata = writeMetadata(loaded.root, {
          ...metadata,
          approvalAttempt: {
            occurredAt: this.now(),
            requestId: `approval-${metadata.runId}`
          }
        })
      }
      const context = this.#openContext(sessionId)
      try {
        const occurredAt = metadata.approvalAttempt.occurredAt
        const approval = new ApprovalGate(context.database, {
          artifactRoot: context.candidateArtifactRoot,
          env: { E3_APPROVAL_GATE_ENABLED: 'true' },
          idFactory: this.idFactory
        }).approve(this.#approvalInput(metadata, occurredAt))
        const exported = new PilotExportService(context.database, {
          artifactRoot: context.candidateArtifactRoot,
          env: { E3_PILOT_EXPORT_ENABLED: 'true' },
          idFactory: this.idFactory
        }).exportApproved({
          sessionId,
          expectedVersion: approval.session.version,
          approvalId: approval.approval.id,
          actorId: metadata.actorId,
          requestId: `export-${metadata.runId}`,
          occurredAt: occurredAt + 1,
          leaseOwner: SESSION_OWNER,
          fencingToken: metadata.sessionFencingToken
        })
        const store = new ArtifactStore(context.candidateArtifactRoot)
        const packageBytes = store.read(exported.export.packageSha256)
        if (sha256(packageBytes) !== exported.export.packageSha256) {
          fail(
            E3_CHAT_ERROR.METADATA_TAMPERED,
            'Export package failed digest verification'
          )
        }
        writeAtomicFile(context.exportPath, packageBytes, 0o600)
        const cleanup = this.#cleanupWorkspace(
          context,
          metadata,
          occurredAt + 2
        )
        const current = context.sessions.getSession(sessionId)
        const completed = current.status === E3_SESSION_STATUS.COMPLETED
          ? current
          : context.sessions.transitionSession({
              type: E3_SESSION_COMMAND.COMPLETE,
              sessionId,
              expectedVersion: current.version,
              actorId: metadata.actorId,
              requestId: `complete-${metadata.runId}`,
              occurredAt: occurredAt + 3,
              leaseOwner: SESSION_OWNER,
              fencingToken: metadata.sessionFencingToken
            }).session
        const updated = writeMetadata(context.sessionRoot, {
          ...metadata,
          status: E3_CHAT_STATUS.COMPLETED,
          updatedAt: occurredAt + 3,
          approval: {
            id: approval.approval.id,
            statementSha256: approval.approval.statementSha256,
            approvedAt: occurredAt
          },
          export: {
            id: exported.export.id,
            packageSha256: exported.export.packageSha256,
            bytes: packageBytes.length,
            path: basename(context.exportPath),
            exportedAt: occurredAt + 1,
            sessionState: completed.status,
            cleanup
          }
        })
        return this.#publicMetadata(updated)
      } finally {
        if (context.database.open) context.database.close()
      }
    } finally {
      actionLock.release()
    }
  }

  denyChange({ sessionId, userId }) {
    this.#assertEnabled()
    assertSessionId(sessionId)
    this.#prepareStorage()
    const actionLock = acquireManagerLock(
      this.#lockPath(`action-${sessionId}`),
      { owner: `deny-${userId}`, acquiredAt: this.now() }
    )
    try {
      const loaded = this.#loadOwned(sessionId, userId)
      const metadata = loaded.metadata
      if (metadata.status === E3_CHAT_STATUS.DENIED) {
        return this.#publicMetadata(metadata, { replayed: true })
      }
      if (metadata.status !== E3_CHAT_STATUS.READY_FOR_REVIEW) {
        fail(
          E3_CHAT_ERROR.STATE_CONFLICT,
          'Only a review-ready E3 session can be denied',
          { status: metadata.status }
        )
      }
      const context = this.#openContext(sessionId)
      try {
        const occurredAt = this.now()
        const current = context.sessions.getSession(sessionId)
        const cancelled = current.status === E3_SESSION_STATUS.CANCELLED
          ? current
          : context.sessions.transitionSession({
              type: E3_SESSION_COMMAND.CANCEL,
              sessionId,
              expectedVersion: current.version,
              actorId: metadata.actorId,
              requestId: `deny-${metadata.runId}`,
              occurredAt,
              leaseOwner: SESSION_OWNER,
              fencingToken: metadata.sessionFencingToken
            }).session
        const cleanup = this.#cleanupWorkspace(
          context,
          metadata,
          occurredAt + 1
        )
        const updated = writeMetadata(context.sessionRoot, {
          ...metadata,
          status: E3_CHAT_STATUS.DENIED,
          updatedAt: occurredAt + 1,
          failure: {
            code: 'DENIED_BY_USER',
            message: 'User denied the E3 review',
            sessionState: cancelled.status,
            cleanup
          }
        })
        return this.#publicMetadata(updated)
      } finally {
        if (context.database.open) context.database.close()
      }
    } finally {
      actionLock.release()
    }
  }

  getSession({ sessionId, userId }) {
    this.#assertEnabled()
    const { metadata } = this.#loadOwned(
      assertSessionId(sessionId),
      userId
    )
    return this.#publicMetadata(metadata)
  }

  requestApproval({ sessionId, userId, conversationId }) {
    this.#assertEnabled()
    const { metadata } = this.#loadOwned(
      assertSessionId(sessionId),
      userId,
      conversationId
    )
    if (metadata.status !== E3_CHAT_STATUS.READY_FOR_REVIEW) {
      fail(
        E3_CHAT_ERROR.STATE_CONFLICT,
        'E3 session is not waiting for approval',
        { status: metadata.status }
      )
    }
    return this.#publicMetadata(metadata, { actionRequired: true })
  }

  listSessions({ userId, conversationId = null }) {
    this.#assertEnabled()
    this.#prepareStorage()
    assertPositiveInteger(userId, 'userId')
    if (conversationId !== null) {
      assertPositiveInteger(conversationId, 'conversationId')
    }
    const root = join(this.storageRoot, 'sessions')
    if (!existsSync(root)) return Object.freeze([])
    const sessions = []
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !UUID_PATTERN.test(entry.name)) continue
      try {
        const metadata = readMetadata(join(root, entry.name))
        if (
          metadata.userId === userId &&
          (
            conversationId === null ||
            metadata.conversationId === conversationId
          )
        ) {
          sessions.push(this.#publicMetadata(metadata))
        }
      } catch {}
    }
    return Object.freeze(
      sessions
        .sort((left, right) => right.createdAt - left.createdAt)
        .slice(0, 50)
    )
  }

  readExport({ sessionId, userId }) {
    this.#assertEnabled()
    const { metadata } = this.#loadOwned(
      assertSessionId(sessionId),
      userId
    )
    if (
      metadata.status !== E3_CHAT_STATUS.COMPLETED ||
      !metadata.export?.packageSha256
    ) {
      fail(
        E3_CHAT_ERROR.STATE_CONFLICT,
        'E3 export is not available for this session'
      )
    }
    const path = this.#paths(sessionId).exportPath
    let stat
    let bytes
    try {
      stat = lstatSync(path)
      bytes = readFileSync(path)
    } catch (cause) {
      fail(
        E3_CHAT_ERROR.NOT_FOUND,
        'E3 export file is unavailable',
        {},
        cause
      )
    }
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid() ||
      (stat.mode & 0o777) !== 0o600 ||
      sha256(bytes) !== metadata.export.packageSha256
    ) {
      fail(
        E3_CHAT_ERROR.METADATA_TAMPERED,
        'E3 export file failed safety verification'
      )
    }
    return Object.freeze({
      bytes,
      filename: `echolink-e3-${sessionId}.tar`,
      sha256: metadata.export.packageSha256
    })
  }

  #publicMetadata(metadata, extra = {}) {
    return Object.freeze({
      ok: true,
      sessionId: metadata.sessionId,
      conversationId: metadata.conversationId,
      summary: metadata.summary,
      status: metadata.status,
      baselineCommit: metadata.baselineCommit,
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
      operationCount: metadata.operationCount,
      operationPaths: metadata.operationPaths,
      candidate: metadata.candidate
        ? {
            id: metadata.candidate.id,
            candidateManifestSha256:
              metadata.candidate.candidateManifestSha256,
            forwardPatchSha256:
              metadata.candidate.forwardPatchSha256,
            reversePatchSha256:
              metadata.candidate.reversePatchSha256,
            treeSha: metadata.candidate.treeSha
          }
        : null,
      validation: metadata.validation,
      review: metadata.review
        ? {
            id: metadata.review.id,
            validationManifestSha256:
              metadata.review.validationManifestSha256,
            reviewSummarySha256:
              metadata.review.reviewSummarySha256
          }
        : null,
      diff: metadata.diff || null,
      approval: metadata.approval,
      export: metadata.export
        ? {
            ...metadata.export,
            downloadUrl:
              `/api/chat/e3/session/${metadata.sessionId}/export`
          }
        : null,
      failure: metadata.failure,
      ...extra
    })
  }
}

export function e3ChatFeatureEnabled(env = process.env) {
  return env[E3_CHAT_FEATURE_FLAG] === 'true'
}
