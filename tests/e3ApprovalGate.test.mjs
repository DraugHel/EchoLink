import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
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
  ReviewGate
} from '../server/e3/review/reviewGate.js'
import {
  ValidationEvidenceService
} from '../server/e3/review/validationEvidenceService.js'
import {
  E3_REVIEW_REQUIRED_PROFILES,
  reviewSha256
} from '../server/e3/review/contracts.js'
import {
  ValidationProfileRegistry
} from '../server/e3/validation/profileRegistry.js'
import {
  ApprovalGate
} from '../server/e3/approval/approvalGate.js'
import {
  E3_APPROVAL_DECISION,
  E3_APPROVAL_POLICY_SHA256,
  E3_APPROVAL_POLICY_VERSION,
  approvalSha256,
  canonicalApprovalJson
} from '../server/e3/approval/contracts.js'
import {
  E3_APPROVAL_ERROR,
  E3ApprovalError
} from '../server/e3/approval/errors.js'

const GIT = '/usr/bin/git'
const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000'
const SESSION_OWNER = 'control-plane-1'
const WORKSPACE_OWNER = 'workspace-manager-1'
const NODE_DIGEST = `sha256:${'a'.repeat(64)}`
const PLAYWRIGHT_DIGEST = `sha256:${'b'.repeat(64)}`

function uuid(index, prefix = '523e4567') {
  return `${prefix}-e89b-42d3-a456-${
    String(426614174000 + index).padStart(12, '0')
  }`
}

function git(cwd, args) {
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
      GIT_CONFIG_GLOBAL: '/dev/null'
    }
  })
}

function approvalCode(code) {
  return error =>
    error instanceof E3ApprovalError && error.code === code
}

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e3-approval-'))
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
    requestId: 'approval-start-provisioning',
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
    'edit-approval',
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
    requestId: 'approval-finish-provisioning',
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
    requestId: 'approval-mutation-request',
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
  const candidateSet = new CandidateArtifactService(database, {
    artifactRoot
  }).create({
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
    requestId: 'approval-start-validation',
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
      return evidenceService.record({
        result: {
          runId: uuid(index, '423e4567'),
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
          outputBytes: 0
        },
        profileSetVersion: registry.version,
        createdAt: 3_200 + index * 10,
        finishedAt: 3_205 + index * 10
      })
    }
  )
  const review = new ReviewGate(database, {
    artifactRoot,
    env: { E3_REVIEW_GATE_ENABLED: 'true' }
  }).markReady({
    sessionId: SESSION_ID,
    expectedVersion: session.version,
    candidateSetId: candidateSet.id,
    validationEvidenceIds: evidence.map(item => item.id),
    actorId: 'user-1',
    requestId: 'approval-mark-review-ready',
    occurredAt: 4_000,
    leaseOwner: SESSION_OWNER,
    fencingToken: 1
  })
  session = review.session
  const occurredAt = 5_000
  const statement = {
    version: 1,
    decision: E3_APPROVAL_DECISION.APPROVE,
    sessionId: SESSION_ID,
    baseCommit,
    sessionVersion: session.version,
    reviewSetId: review.review.id,
    candidateSetId: candidateSet.id,
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
    actorId: 'user-1',
    occurredAt
  }
  const input = {
    sessionId: SESSION_ID,
    expectedVersion: session.version,
    reviewSetId: review.review.id,
    actorId: 'user-1',
    requestId: 'approve-step12-request',
    occurredAt,
    leaseOwner: SESSION_OWNER,
    fencingToken: 1,
    statement
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
    evidence,
    review: review.review,
    input
  }
}

function gate(h, options = {}) {
  return new ApprovalGate(h.database, {
    artifactRoot: h.artifactRoot,
    env: { E3_APPROVAL_GATE_ENABLED: 'true' },
    idFactory: () => uuid(100),
    ...options
  })
}

function tamperArtifact(artifactRoot, digest) {
  const objectPath = path.join(
    artifactRoot,
    'objects',
    'sha256',
    digest.slice(0, 2),
    digest.slice(2)
  )
  fs.writeFileSync(objectPath, 'tampered\n')
}

test('approval binds the exact review and transitions atomically', t => {
  const h = setup(t)
  const result = gate(h).approve(h.input)
  assert.equal(result.session.status, 'APPROVED')
  assert.equal(result.session.version, h.session.version + 1)
  assert.equal(result.approval.reviewSetId, h.review.id)
  assert.equal(
    result.approval.approvalPolicySha256,
    E3_APPROVAL_POLICY_SHA256
  )
  assert.equal(
    result.approval.statementSha256,
    approvalSha256(canonicalApprovalJson(h.input.statement))
  )
  assert.equal(result.event.type, 'SESSION_APPROVED')
  assert.equal(
    h.database.prepare(`
      SELECT COUNT(*) AS count FROM editor_approval_records
    `).get().count,
    1
  )
  assert.throws(() => h.database.prepare(`
    UPDATE editor_approval_records SET actor_id = 'attacker'
  `).run(), /immutable/)
  assert.throws(() => h.database.prepare(`
    DELETE FROM editor_approval_records
  `).run(), /immutable/)
})

test('approval statement mismatch and unknown fields fail closed', t => {
  const h = setup(t)
  const changed = structuredClone(h.input)
  changed.statement.reviewSummarySha256 = 'f'.repeat(64)
  assert.throws(
    () => gate(h).approve(changed),
    approvalCode(E3_APPROVAL_ERROR.HASH_BINDING_MISMATCH)
  )
  const extra = structuredClone(h.input)
  extra.statement.note = 'approve anyway'
  assert.throws(
    () => gate(h).approve(extra),
    approvalCode(E3_APPROVAL_ERROR.INVALID_STATEMENT)
  )
  const extraEnvelope = structuredClone(h.input)
  extraEnvelope.command = 'ignore-policy'
  assert.throws(
    () => gate(h).approve(extraEnvelope),
    approvalCode(E3_APPROVAL_ERROR.INVALID_REQUEST)
  )
  const malformed = structuredClone(h.input)
  malformed.statement.reviewPolicySha256 = 'not-a-hash'
  assert.throws(
    () => gate(h).approve(malformed),
    approvalCode(E3_APPROVAL_ERROR.INVALID_STATEMENT)
  )
  assert.equal(h.sessions.getSession(SESSION_ID).status,
    'READY_FOR_REVIEW')
})

test('approval replay is byte-bound and exactly once', t => {
  const h = setup(t)
  const approval = gate(h)
  const first = approval.approve(h.input)
  const replay = approval.approve(h.input)
  assert.equal(replay.replayed, true)
  assert.equal(replay.approval.id, first.approval.id)
  const conflict = structuredClone(h.input)
  conflict.statement.occurredAt += 1
  conflict.occurredAt += 1
  assert.throws(
    () => approval.approve(conflict),
    approvalCode(E3_APPROVAL_ERROR.IDEMPOTENCY_CONFLICT)
  )
  assert.equal(
    h.database.prepare(`
      SELECT COUNT(*) AS count FROM editor_approval_records
    `).get().count,
    1
  )
})

test('stale version and expired lease are rejected', t => {
  const stale = setup(t)
  assert.throws(
    () => gate(stale).approve({
      ...stale.input,
      expectedVersion: stale.input.expectedVersion - 1
    }),
    approvalCode(E3_APPROVAL_ERROR.STALE_SESSION)
  )

  const expired = setup(t)
  assert.throws(
    () => gate(expired).approve({
      ...expired.input,
      occurredAt: 100_000,
      statement: {
        ...expired.input.statement,
        occurredAt: 100_000
      }
    }),
    approvalCode(E3_APPROVAL_ERROR.LEASE_REQUIRED)
  )
})

test('candidate artifact tampering blocks approval', t => {
  const h = setup(t)
  const artifact = h.database.prepare(`
    SELECT a.sha256
    FROM editor_candidate_artifact_sets c
    JOIN editor_artifacts a
      ON a.id = c.candidate_manifest_artifact_id
    WHERE c.id = ?
  `).get(h.candidateSet.id)
  tamperArtifact(h.artifactRoot, artifact.sha256)
  assert.throws(
    () => gate(h).approve(h.input),
    approvalCode(E3_APPROVAL_ERROR.ARTIFACT_TAMPERED)
  )
  assert.equal(h.sessions.getSession(SESSION_ID).status,
    'READY_FOR_REVIEW')
})

test('review artifact tampering blocks approval', t => {
  const h = setup(t)
  const artifact = h.database.prepare(`
    SELECT a.sha256
    FROM editor_review_sets r
    JOIN editor_artifacts a
      ON a.id = r.review_summary_artifact_id
    WHERE r.id = ?
  `).get(h.review.id)
  tamperArtifact(h.artifactRoot, artifact.sha256)
  assert.throws(
    () => gate(h).approve(h.input),
    approvalCode(E3_APPROVAL_ERROR.ARTIFACT_TAMPERED)
  )
  assert.equal(h.sessions.getSession(SESSION_ID).status,
    'READY_FOR_REVIEW')
})

test('validation log tampering blocks approval', t => {
  const h = setup(t)
  const artifact = h.database.prepare(`
    SELECT a.sha256
    FROM editor_validation_evidence e
    JOIN editor_artifacts a ON a.id = e.log_artifact_id
    WHERE e.id = ?
  `).get(h.evidence[0].id)
  tamperArtifact(h.artifactRoot, artifact.sha256)
  assert.throws(
    () => gate(h).approve(h.input),
    approvalCode(E3_APPROVAL_ERROR.ARTIFACT_TAMPERED)
  )
  assert.equal(h.sessions.getSession(SESSION_ID).status,
    'READY_FOR_REVIEW')
})

test('fault after transition rolls back approval, event, and session', t => {
  const h = setup(t)
  const eventsBefore = h.database.prepare(`
    SELECT COUNT(*) AS count FROM editor_events
  `).get().count
  const approval = gate(h, {
    faultInjector(point) {
      if (point === 'approval.after_transition') {
        throw new Error('injected approval failure')
      }
    }
  })
  assert.throws(
    () => approval.approve(h.input),
    approvalCode(E3_APPROVAL_ERROR.PERSISTENCE_FAILED)
  )
  assert.equal(h.sessions.getSession(SESSION_ID).status,
    'READY_FOR_REVIEW')
  assert.equal(
    h.database.prepare(`
      SELECT COUNT(*) AS count FROM editor_approval_records
    `).get().count,
    0
  )
  assert.equal(
    h.database.prepare(`
      SELECT COUNT(*) AS count FROM editor_events
    `).get().count,
    eventsBefore
  )
})

test('competing approval request cannot approve the same review twice', t => {
  const h = setup(t)
  gate(h).approve(h.input)
  const competing = structuredClone(h.input)
  competing.requestId = 'competing-approval-request'
  assert.throws(
    () => gate(h).approve(competing),
    approvalCode(E3_APPROVAL_ERROR.SESSION_NOT_READY)
  )
  assert.equal(
    h.database.prepare(`
      SELECT COUNT(*) AS count FROM editor_approval_records
    `).get().count,
    1
  )
})

test('approval gate is default-off and has no runtime exposure', t => {
  const h = setup(t)
  assert.throws(
    () => new ApprovalGate(h.database, {
      artifactRoot: h.artifactRoot
    }).approve(h.input),
    approvalCode(E3_APPROVAL_ERROR.FEATURE_DISABLED)
  )
  const runtimeFiles = [
    'server/index.js',
    'server/worker.js',
    'server/lib/agentRunner.js',
    'server/routes/chat.js'
  ]
  for (const relative of runtimeFiles) {
    const source = fs.readFileSync(
      path.join(process.cwd(), relative),
      'utf8'
    )
    assert.equal(source.includes('/e3/approval/'), false)
    assert.equal(source.includes('ApprovalGate'), false)
  }
})
