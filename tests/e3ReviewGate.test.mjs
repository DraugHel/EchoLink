import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  E3_ARTIFACT_TYPE,
  E3_LEASE_RESOURCE_TYPE,
  E3_SESSION_COMMAND
} from '../server/e3/core/contracts.js'
import {
  CandidateArtifactService
} from '../server/e3/artifacts/candidateArtifactService.js'
import {
  E3_EDITOR_OPERATION
} from '../server/e3/editor/contracts.js'
import {
  SessionEditorService
} from '../server/e3/editor/sessionEditorService.js'
import {
  sha256
} from '../server/e3/editor/safeTextFilesystem.js'
import {
  openEditorDatabase
} from '../server/e3/persistence/database.js'
import {
  EditorRepository
} from '../server/e3/persistence/editorRepository.js'
import {
  E3_REVIEW_ERROR,
  E3ReviewError
} from '../server/e3/review/errors.js'
import {
  E3_REVIEW_POLICY_SHA256,
  E3_REVIEW_REQUIRED_PROFILES,
  reviewSha256
} from '../server/e3/review/contracts.js'
import {
  ReviewGate
} from '../server/e3/review/reviewGate.js'
import {
  ValidationEvidenceService
} from '../server/e3/review/validationEvidenceService.js'
import {
  E3_VALIDATION_RUNTIME
} from '../server/e3/validation/contracts.js'
import {
  ValidationProfileRegistry
} from '../server/e3/validation/profileRegistry.js'

const GIT = '/usr/bin/git'
const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000'
const SESSION_OWNER = 'control-plane-1'
const WORKSPACE_OWNER = 'workspace-manager-1'
const NODE_DIGEST = `sha256:${'a'.repeat(64)}`
const PLAYWRIGHT_DIGEST = `sha256:${'b'.repeat(64)}`

function uuid(index, prefix = '423e4567') {
  return `${prefix}-e89b-42d3-a456-${
    String(426614174000 + index).padStart(12, '0')
  }`
}

function git(cwd, args, options = {}) {
  return execFileSync(GIT, args, {
    cwd,
    encoding: options.encoding ?? 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: '/usr/bin:/bin',
      HOME: cwd,
      LC_ALL: 'C',
      LANG: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null'
    }
  })
}

function reviewCode(code) {
  return error =>
    error instanceof E3ReviewError &&
    error.code === code
}

function setup(t, {
  evidenceOverrides = () => ({})
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e3-review-'))
  const workspace = path.join(root, 'workspace')
  const artifactRoot = path.join(root, 'artifacts')
  fs.mkdirSync(workspace)
  git(workspace, ['init', '--initial-branch=main'])
  git(workspace, ['config', 'user.name', 'E3 Test'])
  git(workspace, ['config', 'user.email', 'e3@example.invalid'])
  fs.mkdirSync(path.join(workspace, 'src'))
  fs.writeFileSync(path.join(workspace, 'src', 'a.txt'), 'alpha\n')
  fs.writeFileSync(path.join(workspace, 'README.md'), '# fixture\n')
  git(workspace, ['add', '--all'])
  git(workspace, ['commit', '-m', 'baseline'])
  const baseCommit = git(workspace, ['rev-parse', 'HEAD']).trim()
  const database = openEditorDatabase({
    databasePath: path.join(root, 'editor.db')
  })
  const sessions = new EditorRepository(database)
  let session = sessions.createSession({
    id: SESSION_ID,
    baseCommit,
    createdBy: 'user-1',
    requestSummary: 'Replace alpha with omega',
    createdAt: 1_000,
    leaseOwner: SESSION_OWNER,
    leaseExpiresAt: 100_000
  }).session
  session = sessions.transitionSession({
    type: E3_SESSION_COMMAND.START_PROVISIONING,
    sessionId: SESSION_ID,
    expectedVersion: session.version,
    actorId: 'user-1',
    requestId: 'review-start-provisioning',
    occurredAt: 1_100,
    leaseOwner: SESSION_OWNER,
    fencingToken: 1
  }).session
  sessions.claimLease({
    resourceType: E3_LEASE_RESOURCE_TYPE.WORKSPACE,
    resourceKey: SESSION_ID,
    owner: WORKSPACE_OWNER,
    occurredAt: 1_200,
    expiresAt: 100_000
  })
  database.prepare(`
    INSERT INTO editor_workspaces (
      session_id, workspace_key, state, base_commit, tree_sha,
      canonical_path, manifest_sha256, manager_owner, created_at,
      heartbeat_at, fencing_token, logical_size_bytes, entry_count,
      symlink_count
    ) VALUES (?, ?, 'READY', ?, ?, ?, ?, ?, 1200, 1200, 1, 16, 2, 0)
  `).run(
    SESSION_ID,
    'edit-review',
    baseCommit,
    git(workspace, ['rev-parse', 'HEAD^{tree}']).trim(),
    workspace,
    'c'.repeat(64),
    WORKSPACE_OWNER
  )
  session = sessions.transitionSession({
    type: E3_SESSION_COMMAND.FINISH_PROVISIONING,
    sessionId: SESSION_ID,
    expectedVersion: session.version,
    actorId: 'user-1',
    requestId: 'review-finish-provisioning',
    occurredAt: 1_300,
    leaseOwner: SESSION_OWNER,
    fencingToken: 1
  }).session
  const editor = new SessionEditorService(database, {
    artifactRoot: path.join(root, 'preimages'),
    forbiddenRoots: ['/root/echolink']
  })
  session = editor.mutate({
    sessionId: SESSION_ID,
    requestId: 'review-mutation-request',
    actorId: 'user-1',
    expectedVersion: session.version,
    occurredAt: 2_000,
    sessionOwner: SESSION_OWNER,
    sessionFencingToken: 1,
    workspaceOwner: WORKSPACE_OWNER,
    workspaceFencingToken: 1,
    request: {
      version: 1,
      type: E3_EDITOR_OPERATION.REPLACE_EXACT,
      path: 'src/a.txt',
      expectedSha256: sha256(Buffer.from('alpha\n')),
      search: 'alpha',
      replacement: 'omega'
    }
  }).session
  const candidates = new CandidateArtifactService(database, {
    artifactRoot
  })
  const candidateSet = candidates.create({
    sessionId: SESSION_ID,
    expectedVersion: session.version,
    occurredAt: 3_000,
    sessionOwner: SESSION_OWNER,
    sessionFencingToken: 1,
    workspaceOwner: WORKSPACE_OWNER,
    workspaceFencingToken: 1
  })
  session = sessions.transitionSession({
    type: E3_SESSION_COMMAND.START_VALIDATION,
    sessionId: SESSION_ID,
    expectedVersion: session.version,
    actorId: 'user-1',
    requestId: 'review-start-validation',
    occurredAt: 3_100,
    leaseOwner: SESSION_OWNER,
    fencingToken: 1
  }).session
  const registry = new ValidationProfileRegistry({
    nodeImageDigest: NODE_DIGEST,
    playwrightImageDigest: PLAYWRIGHT_DIGEST
  })
  const evidenceService = new ValidationEvidenceService(database, {
    artifactRoot
  })
  const evidence = E3_REVIEW_REQUIRED_PROFILES.map(
    (profileId, index) => {
      const profile = registry.get(profileId, 1)
      const overrides = evidenceOverrides({
        profileId,
        index,
        profile,
        registry
      })
      return evidenceService.record({
        result: {
          runId: uuid(index),
          sessionId: SESSION_ID,
          candidateSetId: candidateSet.id,
          candidateManifestSha256:
            candidateSet.candidate_manifest_sha256,
          profileId,
          profileVersion: profile.version,
          profileSha256: profile.sha256,
          profileSetVersion: registry.version,
          profileSetSha256: registry.sha256,
          requestSha256: reviewSha256(`request-${profileId}`),
          planSha256: reviewSha256(`plan-${profileId}`),
          status: 'succeeded',
          exitCode: 0,
          signal: null,
          stdout: `${profileId} ok\n`,
          stderr: '',
          outputBytes: 0,
          ...overrides
        },
        profileSetVersion:
          overrides.profileSetVersion ?? registry.version,
        createdAt: 3_200 + index * 10,
        finishedAt: 3_205 + index * 10
      })
    }
  )
  const input = {
    sessionId: SESSION_ID,
    expectedVersion: session.version,
    candidateSetId: candidateSet.id,
    validationEvidenceIds:
      evidence.map(item => item.id).reverse(),
    actorId: 'user-1',
    requestId: 'mark-review-ready-step11',
    occurredAt: 4_000,
    leaseOwner: SESSION_OWNER,
    fencingToken: 1
  }
  t.after(() => {
    if (database.open) database.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return {
    root,
    artifactRoot,
    database,
    sessions,
    session,
    candidateSet,
    registry,
    evidence,
    input
  }
}

test('review gate binds all required evidence and transitions atomically', t => {
  const h = setup(t)
  const gate = new ReviewGate(h.database, {
    artifactRoot: h.artifactRoot,
    env: { E3_REVIEW_GATE_ENABLED: 'true' }
  })
  const result = gate.markReady(h.input)
  assert.equal(result.session.status, 'READY_FOR_REVIEW')
  assert.equal(
    result.session.candidate.candidateManifestSha256,
    h.candidateSet.candidate_manifest_sha256
  )
  assert.equal(
    result.session.candidate.patchSha256,
    h.candidateSet.forward_patch_sha256
  )
  assert.equal(result.review.reviewPolicySha256,
    E3_REVIEW_POLICY_SHA256)
  assert.deepEqual(
    result.review.validationEvidenceIds,
    h.evidence.map(item => item.id)
  )
  const validationManifest = JSON.parse(
    gate.store.read(
      result.review.validationManifestSha256
    ).toString('utf8')
  )
  assert.deepEqual(
    validationManifest.validations.map(item => item.profileId),
    E3_REVIEW_REQUIRED_PROFILES
  )
  const summary = JSON.parse(
    gate.store.read(
      result.review.reviewSummarySha256
    ).toString('utf8')
  )
  assert.deepEqual(summary.changedFiles, ['src/a.txt'])
  assert.equal(summary.operations.length, 1)
  assert.equal(summary.requestSummary, 'Replace alpha with omega')
  assert.equal(
    h.database.prepare(`
      SELECT COUNT(*) AS count FROM editor_review_sets
    `).get().count,
    1
  )
  const replay = gate.markReady(h.input)
  assert.equal(replay.replayed, true)
  assert.equal(replay.review.id, result.review.id)
  assert.throws(() => h.database.prepare(`
    UPDATE editor_review_sets SET actor_id = 'tampered'
  `).run(), /immutable/)
  assert.throws(() => h.database.prepare(`
    DELETE FROM editor_validation_evidence
  `).run(), /immutable/)
})

test('missing, duplicate, or failed evidence never enters review', t => {
  const h = setup(t, {
    evidenceOverrides({ index }) {
      return index === 3
        ? { status: 'failed', exitCode: 1 }
        : {}
    }
  })
  const gate = new ReviewGate(h.database, {
    artifactRoot: h.artifactRoot,
    env: { E3_REVIEW_GATE_ENABLED: 'true' }
  })
  assert.throws(
    () => gate.markReady({
      ...h.input,
      validationEvidenceIds:
        h.input.validationEvidenceIds.slice(1)
    }),
    reviewCode(E3_REVIEW_ERROR.INCOMPLETE_EVIDENCE)
  )
  assert.throws(
    () => gate.markReady({
      ...h.input,
      validationEvidenceIds: [
        ...h.input.validationEvidenceIds.slice(0, -1),
        h.input.validationEvidenceIds[0]
      ]
    }),
    reviewCode(E3_REVIEW_ERROR.INVALID_EVIDENCE)
  )
  assert.throws(
    () => gate.markReady(h.input),
    reviewCode(E3_REVIEW_ERROR.FAILED_VALIDATION)
  )
  assert.equal(h.sessions.getSession(SESSION_ID).status, 'VALIDATING')
})

test('mixed profile sets fail before review publication', t => {
  const h = setup(t, {
    evidenceOverrides({ index }) {
      return index === 7
        ? { profileSetSha256: 'd'.repeat(64) }
        : {}
    }
  })
  const gate = new ReviewGate(h.database, {
    artifactRoot: h.artifactRoot,
    env: { E3_REVIEW_GATE_ENABLED: 'true' }
  })
  assert.throws(
    () => gate.markReady(h.input),
    reviewCode(E3_REVIEW_ERROR.HASH_BINDING_MISMATCH)
  )
  assert.equal(h.sessions.getSession(SESSION_ID).status, 'VALIDATING')
})

test('validation run replay is byte-bound and exactly once', t => {
  const h = setup(t)
  const service = new ValidationEvidenceService(h.database, {
    artifactRoot: h.artifactRoot
  })
  const existing = h.evidence[0]
  const result = {
    runId: existing.id,
    sessionId: existing.sessionId,
    candidateSetId: existing.candidateSetId,
    candidateManifestSha256:
      existing.candidateManifestSha256,
    profileId: existing.profileId,
    profileVersion: existing.profileVersion,
    profileSha256: existing.profileSha256,
    profileSetVersion: existing.profileSetVersion,
    profileSetSha256: existing.profileSetSha256,
    requestSha256: existing.requestSha256,
    planSha256: existing.planSha256,
    status: 'succeeded',
    exitCode: 0,
    signal: null,
    stdout: `${existing.profileId} ok\n`,
    stderr: '',
    outputBytes: 0
  }
  const replay = service.record({
    result,
    profileSetVersion: h.registry.version,
    createdAt: existing.createdAt,
    finishedAt: existing.finishedAt
  })
  assert.equal(replay.id, existing.id)
  assert.equal(h.database.prepare(`
    SELECT COUNT(*) AS count FROM editor_validation_evidence
    WHERE id = ?
  `).get(existing.id).count, 1)
  assert.throws(
    () => service.record({
      result: { ...result, stdout: 'different bytes\n' },
      profileSetVersion: h.registry.version,
      createdAt: existing.createdAt,
      finishedAt: existing.finishedAt
    }),
    reviewCode(E3_REVIEW_ERROR.IDEMPOTENCY_CONFLICT)
  )
})

test('candidate or validation-log tampering fails closed', t => {
  const h = setup(t)
  const gate = new ReviewGate(h.database, {
    artifactRoot: h.artifactRoot,
    env: { E3_REVIEW_GATE_ENABLED: 'true' }
  })
  const log = h.database.prepare(`
    SELECT a.storage_key
    FROM editor_validation_evidence e
    JOIN editor_artifacts a ON a.id = e.log_artifact_id
    WHERE e.id = ?
  `).get(h.evidence[0].id)
  fs.writeFileSync(
    path.join(h.artifactRoot, log.storage_key),
    'tampered'
  )
  assert.throws(
    () => gate.markReady(h.input),
    reviewCode(E3_REVIEW_ERROR.ARTIFACT_TAMPERED)
  )

  const h2 = setup(t)
  const gate2 = new ReviewGate(h2.database, {
    artifactRoot: h2.artifactRoot,
    env: { E3_REVIEW_GATE_ENABLED: 'true' }
  })
  const candidate = h2.database.prepare(`
    SELECT a.storage_key
    FROM editor_candidate_artifact_sets c
    JOIN editor_artifacts a
      ON a.id = c.candidate_manifest_artifact_id
    WHERE c.id = ?
  `).get(h2.candidateSet.id)
  fs.writeFileSync(
    path.join(h2.artifactRoot, candidate.storage_key),
    'tampered'
  )
  assert.throws(
    () => gate2.markReady(h2.input),
    reviewCode(E3_REVIEW_ERROR.ARTIFACT_TAMPERED)
  )
})

test('stale version and expired fencing lease are rejected', t => {
  const h = setup(t)
  const gate = new ReviewGate(h.database, {
    artifactRoot: h.artifactRoot,
    env: { E3_REVIEW_GATE_ENABLED: 'true' }
  })
  assert.throws(
    () => gate.markReady({
      ...h.input,
      expectedVersion: h.input.expectedVersion - 1
    }),
    reviewCode(E3_REVIEW_ERROR.STALE_SESSION)
  )
  assert.throws(
    () => gate.markReady({
      ...h.input,
      occurredAt: 100_000
    }),
    reviewCode(E3_REVIEW_ERROR.LEASE_REQUIRED)
  )
  assert.equal(h.sessions.getSession(SESSION_ID).status, 'VALIDATING')
})

test('fault after transition rolls back session and all review metadata', t => {
  const h = setup(t)
  const gate = new ReviewGate(h.database, {
    artifactRoot: h.artifactRoot,
    env: { E3_REVIEW_GATE_ENABLED: 'true' },
    faultInjector(point) {
      if (point === 'review.after_transition') {
        throw new Error('injected crash')
      }
    }
  })
  assert.throws(
    () => gate.markReady(h.input),
    reviewCode(E3_REVIEW_ERROR.PERSISTENCE_FAILED)
  )
  assert.equal(h.sessions.getSession(SESSION_ID).status, 'VALIDATING')
  assert.equal(h.database.prepare(`
    SELECT COUNT(*) AS count FROM editor_review_sets
  `).get().count, 0)
  assert.equal(h.database.prepare(`
    SELECT COUNT(*) AS count FROM editor_artifacts
    WHERE artifact_type IN ('validation_manifest', 'review_summary')
  `).get().count, 0)
  assert.equal(h.database.prepare(`
    SELECT COUNT(*) AS count FROM editor_idempotency_keys
    WHERE request_id = ?
  `).get(h.input.requestId).count, 0)
})

test('review feature is default-off and exposes no runtime capability', t => {
  const h = setup(t)
  const gate = new ReviewGate(h.database, {
    artifactRoot: h.artifactRoot
  })
  assert.throws(
    () => gate.markReady(h.input),
    reviewCode(E3_REVIEW_ERROR.FEATURE_DISABLED)
  )
  for (const file of [
    'server/e3/review/reviewGate.js',
    'server/e3/review/validationEvidenceService.js'
  ]) {
    const source = fs.readFileSync(
      path.join(process.cwd(), file),
      'utf8'
    )
    assert.equal(source.includes('child_process'), false)
    assert.equal(source.includes('/root/echolink'), false)
    assert.equal(source.includes('pm2'), false)
    assert.equal(source.includes('docker run'), false)
  }
})

test('broker result contract carries review binding versions', async () => {
  const source = fs.readFileSync(
    path.join(
      process.cwd(),
      'server/e3/validation/validationBroker.js'
    ),
    'utf8'
  )
  assert.ok(source.includes('profileVersion: plan.profile.version'))
  assert.ok(source.includes(
    'profileSetVersion: plan.profileSet.version'
  ))
  assert.equal(E3_VALIDATION_RUNTIME.version, '24.18.0')
})
