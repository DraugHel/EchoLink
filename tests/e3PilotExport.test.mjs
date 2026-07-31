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
import {
  PilotExportService
} from '../server/e3/export/pilotExportService.js'
import {
  E3_PILOT_EXPORT_POLICY_SHA256,
  canonicalExportJson
} from '../server/e3/export/contracts.js'
import {
  E3_PILOT_EXPORT_ERROR,
  E3PilotExportError
} from '../server/e3/export/errors.js'
import {
  buildDeterministicTar,
  parseDeterministicTar
} from '../server/e3/export/deterministicTar.js'

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


function exportCode(code) {
  return error =>
    error instanceof E3PilotExportError && error.code === code
}

function approvedSetup(t) {
  const h = setup(t)
  const approval = gate(h).approve(h.input)
  const input = {
    sessionId: SESSION_ID,
    expectedVersion: approval.session.version,
    approvalId: approval.approval.id,
    actorId: 'user-1',
    requestId: 'pilot-export-step13-request',
    occurredAt: 6_000,
    leaseOwner: SESSION_OWNER,
    fencingToken: 1
  }
  return {
    ...h,
    approval,
    approvalInput: h.input,
    input
  }
}

function exportService(h, options = {}) {
  let nextId = 200
  return new PilotExportService(h.database, {
    artifactRoot: h.artifactRoot,
    env: { E3_PILOT_EXPORT_ENABLED: 'true' },
    idFactory: () => uuid(nextId++),
    ...options
  })
}

function artifactPath(root, digest) {
  return path.join(
    root,
    'objects',
    'sha256',
    digest.slice(0, 2),
    digest.slice(2)
  )
}

function packageEntries(h, result) {
  const bytes = fs.readFileSync(
    artifactPath(h.artifactRoot, result.export.packageSha256)
  )
  return new Map(
    parseDeterministicTar(bytes).map(entry => [entry.name, entry.content])
  )
}

test('pilot export packages the exact approval and reaches EXPORTED atomically', t => {
  const h = approvedSetup(t)
  const result = exportService(h).exportApproved(h.input)
  assert.equal(result.replayed, false)
  assert.equal(result.session.status, 'EXPORTED')
  assert.equal(
    result.session.version,
    h.approval.session.version + 2
  )
  assert.equal(
    result.session.exportArtifact.sha256,
    result.export.packageSha256
  )
  assert.equal(result.export.approvalId, h.approval.approval.id)
  assert.equal(
    result.export.exportPolicySha256,
    E3_PILOT_EXPORT_POLICY_SHA256
  )
  const events = h.sessions.listEvents(SESSION_ID)
  assert.deepEqual(
    events.slice(-2).map(event => event.type),
    ['EXPORT_STARTED', 'EXPORT_FINISHED']
  )
  const entries = packageEntries(h, result)
  assert.equal(entries.size, 18)
  for (const name of [
    'E3-EXPORT-MANIFEST.json',
    'SHA256SUMS',
    'approval/approval-statement.json',
    'candidate/candidate-manifest.json',
    'patches/forward.patch',
    'patches/reverse.patch',
    'review/unified.diff',
    'review/diff-stat.txt',
    'review/validation-manifest.json',
    'review/review-summary.json',
    'validation/logs/0001.log',
    'validation/logs/0008.log'
  ]) {
    assert.equal(entries.has(name), true, name)
  }
  const manifestBytes = entries.get('E3-EXPORT-MANIFEST.json')
  const manifest = JSON.parse(manifestBytes.toString('utf8'))
  assert.equal(
    manifestBytes.toString('utf8'),
    canonicalExportJson(manifest)
  )
  assert.equal(manifest.manualApplyOnly, true)
  assert.equal(manifest.productiveApplyEnabled, false)
  assert.equal(manifest.approvalId, h.approval.approval.id)
  assert.throws(() => h.database.prepare(`
    UPDATE editor_pilot_export_records SET actor_id = 'attacker'
  `).run(), /immutable/)
  assert.throws(() => h.database.prepare(`
    DELETE FROM editor_pilot_export_records
  `).run(), /immutable/)
})

test('exported forward and reverse patches remain manually applicable', t => {
  const h = approvedSetup(t)
  const result = exportService(h).exportApproved(h.input)
  const entries = packageEntries(h, result)
  const check = path.join(h.root, 'export-check')
  git(h.root, ['clone', '--quiet', h.root + '/workspace', check])
  git(check, ['checkout', '--detach', h.input.statement?.baseCommit || h.input.baseCommit || h.approval.approval.baseCommit])
  const forward = path.join(h.root, 'forward.patch')
  const reverse = path.join(h.root, 'reverse.patch')
  fs.writeFileSync(forward, entries.get('patches/forward.patch'))
  fs.writeFileSync(reverse, entries.get('patches/reverse.patch'))
  git(check, ['apply', '--check', forward])
  git(check, ['apply', forward])
  assert.equal(fs.readFileSync(path.join(check, 'src/a.txt'), 'utf8'), 'omega\n')
  git(check, ['apply', '--check', reverse])
  git(check, ['apply', reverse])
  assert.equal(fs.readFileSync(path.join(check, 'src/a.txt'), 'utf8'), 'alpha\n')
})

test('byte-identical export replay is stable after downstream transition', t => {
  const h = approvedSetup(t)
  const service = exportService(h)
  const first = service.exportApproved(h.input)
  const replay = service.exportApproved(h.input)
  assert.equal(replay.replayed, true)
  assert.equal(replay.export.id, first.export.id)
  assert.equal(replay.export.packageSha256, first.export.packageSha256)
  const approvalReplay = gate(h).approve(h.approvalInput)
  assert.equal(approvalReplay.replayed, true)
  assert.equal(approvalReplay.session.status, 'EXPORTED')
})

test('request-id reuse with changed bytes fails closed', t => {
  const h = approvedSetup(t)
  const service = exportService(h)
  service.exportApproved(h.input)
  assert.throws(
    () => service.exportApproved({
      ...h.input,
      actorId: 'user-2'
    }),
    exportCode(E3_PILOT_EXPORT_ERROR.IDEMPOTENCY_CONFLICT)
  )
})

test('stale versions, wrong lease, and wrong approval are rejected', t => {
  const h = approvedSetup(t)
  const service = exportService(h)
  assert.throws(
    () => service.exportApproved({
      ...h.input,
      expectedVersion: h.input.expectedVersion - 1
    }),
    exportCode(E3_PILOT_EXPORT_ERROR.STALE_SESSION)
  )
  assert.throws(
    () => service.exportApproved({
      ...h.input,
      leaseOwner: 'other-owner'
    }),
    exportCode(E3_PILOT_EXPORT_ERROR.LEASE_REQUIRED)
  )
  assert.throws(
    () => service.exportApproved({
      ...h.input,
      approvalId: uuid(999)
    }),
    exportCode(E3_PILOT_EXPORT_ERROR.APPROVAL_MISMATCH)
  )
})

test('source artifact tampering blocks export before state change', t => {
  const h = approvedSetup(t)
  tamperArtifact(
    h.artifactRoot,
    h.approval.approval.forwardPatchSha256
  )
  assert.throws(
    () => exportService(h).exportApproved(h.input),
    exportCode(E3_PILOT_EXPORT_ERROR.APPROVAL_MISMATCH)
  )
  assert.equal(h.sessions.getSession(SESSION_ID).status, 'APPROVED')
  assert.equal(
    h.database.prepare(`
      SELECT COUNT(*) AS count FROM editor_pilot_export_records
    `).get().count,
    0
  )
})

test('export package tampering blocks replay', t => {
  const h = approvedSetup(t)
  const service = exportService(h)
  const result = service.exportApproved(h.input)
  fs.writeFileSync(
    artifactPath(h.artifactRoot, result.export.packageSha256),
    'tampered\n'
  )
  assert.throws(
    () => service.exportApproved(h.input),
    exportCode(E3_PILOT_EXPORT_ERROR.ARTIFACT_TAMPERED)
  )
})

test('fault after START_EXPORT rolls back all database effects', t => {
  const h = approvedSetup(t)
  const version = h.approval.session.version
  const eventCount = h.sessions.listEvents(SESSION_ID).length
  const service = exportService(h, {
    faultInjector(point) {
      if (point === 'after_start_transition') {
        throw new Error('simulated export crash')
      }
    }
  })
  assert.throws(
    () => service.exportApproved(h.input),
    exportCode(E3_PILOT_EXPORT_ERROR.PERSISTENCE_FAILED)
  )
  const session = h.sessions.getSession(SESSION_ID)
  assert.equal(session.status, 'APPROVED')
  assert.equal(session.version, version)
  assert.equal(h.sessions.listEvents(SESSION_ID).length, eventCount)
  assert.equal(
    h.database.prepare(`
      SELECT COUNT(*) AS count FROM editor_pilot_export_records
    `).get().count,
    0
  )
  assert.equal(
    h.database.prepare(`
      SELECT COUNT(*) AS count FROM editor_artifacts
      WHERE artifact_type = 'export_package'
    `).get().count,
    0
  )
})

test('second export for one approval is rejected and never duplicates records', t => {
  const h = approvedSetup(t)
  const service = exportService(h)
  service.exportApproved(h.input)
  assert.throws(
    () => service.exportApproved({
      ...h.input,
      requestId: 'pilot-export-second-request',
      occurredAt: 6_100
    }),
    exportCode(E3_PILOT_EXPORT_ERROR.SESSION_NOT_APPROVED)
  )
  assert.equal(
    h.database.prepare(`
      SELECT COUNT(*) AS count FROM editor_pilot_export_records
    `).get().count,
    1
  )
})

test('feature flag is exact and default-off', t => {
  const h = approvedSetup(t)
  const service = new PilotExportService(h.database, {
    artifactRoot: h.artifactRoot,
    env: { E3_PILOT_EXPORT_ENABLED: 'TRUE' }
  })
  assert.throws(
    () => service.exportApproved(h.input),
    exportCode(E3_PILOT_EXPORT_ERROR.FEATURE_DISABLED)
  )
  for (const relative of [
    'server/index.js',
    'server/worker.js',
    'server/lib/agentRunner.js',
    'server/routes/chat.js'
  ]) {
    const source = fs.readFileSync(
      path.join(process.cwd(), relative),
      'utf8'
    )
    assert.equal(source.includes('/e3/export/'), false)
    assert.equal(source.includes('PilotExportService'), false)
  }
})

test('deterministic tar is order-independent and rejects tampering', () => {
  const left = buildDeterministicTar([
    { name: 'b.txt', content: 'beta\n' },
    { name: 'a.txt', content: 'alpha\n' }
  ])
  const right = buildDeterministicTar([
    { name: 'a.txt', content: 'alpha\n' },
    { name: 'b.txt', content: 'beta\n' }
  ])
  assert.deepEqual(left, right)
  assert.deepEqual(
    parseDeterministicTar(left).map(entry => entry.name),
    ['a.txt', 'b.txt']
  )
  const tampered = Buffer.from(left)
  tampered[0] ^= 1
  assert.throws(() => parseDeterministicTar(tampered))
})
