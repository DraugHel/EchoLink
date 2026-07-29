import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  E3_ARTIFACT_TYPES,
  E3DomainError,
  E3_EVENT_TYPES,
  E3_FAILURE_CODE,
  E3_FAILURE_CODES,
  E3_LEASE_RESOURCE_TYPES,
  E3_OPERATION_TYPES,
  E3_RESERVED_SESSION_COMMANDS,
  E3_RESERVED_SESSION_STATUSES,
  E3_SESSION_COMMAND,
  E3_SESSION_COMMANDS,
  E3_SESSION_STATUS,
  E3_SESSION_STATUSES,
  E3_VALIDATION_STATUSES,
  isCanonicalSessionId,
  isFullGitCommit,
  isSha256
} from '../server/e3/core/contracts.js'
import {
  allowedSessionTargets,
  createEditorSession,
  isSessionTransitionAllowed,
  transitionEditorSession
} from '../server/e3/core/sessionState.js'

const S = E3_SESSION_STATUS
const C = E3_SESSION_COMMAND

const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000'
const OTHER_SESSION_ID =
  '123e4567-e89b-42d3-a456-426614174001'
const BASE_COMMIT = 'a'.repeat(40)
const OTHER_COMMIT = 'b'.repeat(40)
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const HASH_C = 'c'.repeat(64)
const HASH_D = 'd'.repeat(64)
const LEASE = Object.freeze({
  owner: 'control-plane-1',
  fencingToken: 7
})

const CANDIDATE = Object.freeze({
  candidateManifestSha256: HASH_A,
  patchSha256: HASH_B,
  validationManifestSha256: HASH_C,
  pathPolicyVersion: 'paths-v1',
  profileSetVersion: 'profiles-v1'
})

function expectDomainCode(code) {
  return error => (
    error instanceof E3DomainError &&
    error.code === code
  )
}

function createSession() {
  return createEditorSession({
    id: SESSION_ID,
    baseCommit: BASE_COMMIT,
    createdBy: 'user-1',
    requestSummary: 'Prompt cache erweitern',
    createdAt: 1_000
  }).session
}

function command(session, type, overrides = {}) {
  return {
    type,
    sessionId: SESSION_ID,
    expectedVersion: session.version,
    actorId: 'user-1',
    requestId: `request-${session.version}-${type}`,
    occurredAt: 2_000 + session.version,
    leaseOwner: LEASE.owner,
    fencingToken: LEASE.fencingToken,
    ...overrides
  }
}

function apply(session, type, overrides = {}) {
  return transitionEditorSession(
    session,
    command(session, type, overrides),
    { currentLease: LEASE }
  )
}

function toEditing(session = createSession()) {
  session = apply(session, C.START_PROVISIONING).session
  return apply(session, C.FINISH_PROVISIONING).session
}

function toReview(session = toEditing()) {
  session = apply(session, C.START_VALIDATION).session
  return apply(session, C.MARK_READY_FOR_REVIEW, {
    candidate: CANDIDATE
  }).session
}

function approvalBinding(session) {
  return {
    sessionId: session.id,
    baseCommit: session.baseCommit,
    candidateManifestSha256:
      session.candidate.candidateManifestSha256,
    patchSha256: session.candidate.patchSha256,
    validationManifestSha256:
      session.candidate.validationManifestSha256,
    pathPolicyVersion: session.candidate.pathPolicyVersion,
    profileSetVersion: session.candidate.profileSetVersion
  }
}

function toApproved(session = toReview()) {
  return apply(session, C.APPROVE, {
    binding: approvalBinding(session)
  }).session
}

function arbitrarySession(status) {
  const session = {
    ...createSession(),
    status,
    version: 12
  }

  if ([
    S.READY_FOR_REVIEW,
    S.APPROVED,
    S.EXPORTING,
    S.EXPORTED,
    S.COMPLETED
  ].includes(status)) {
    session.candidate = CANDIDATE
    session.reviewReadyAt = 1_100
  }

  if ([
    S.APPROVED,
    S.EXPORTING,
    S.EXPORTED,
    S.COMPLETED
  ].includes(status)) {
    session.approval = Object.freeze({
      sessionId: SESSION_ID,
      baseCommit: BASE_COMMIT,
      ...CANDIDATE,
      approvedBy: 'user-1',
      approvedAt: 1_200
    })
  }

  if ([S.EXPORTED, S.COMPLETED].includes(status)) {
    session.exportArtifact = Object.freeze({
      sha256: HASH_D,
      exportedAt: 1_300
    })
  }

  return Object.freeze(session)
}

test('Core-Verträge sind vollständig, eindeutig und eingefroren', () => {
  for (const values of [
    E3_SESSION_STATUSES,
    E3_SESSION_COMMANDS,
    E3_EVENT_TYPES,
    E3_FAILURE_CODES,
    E3_OPERATION_TYPES,
    E3_ARTIFACT_TYPES,
    E3_VALIDATION_STATUSES,
    E3_LEASE_RESOURCE_TYPES
  ]) {
    assert.equal(new Set(values).size, values.length)
    assert.equal(Object.isFrozen(values), true)
  }

  assert.deepEqual(E3_RESERVED_SESSION_STATUSES, [
    'APPLYING',
    'APPLIED',
    'FINAL_VERIFYING',
    'REVERTING',
    'REVERTED'
  ])
  assert.deepEqual(E3_RESERVED_SESSION_COMMANDS, [
    'START_APPLY',
    'START_REVERT'
  ])

  assert.equal(isCanonicalSessionId(SESSION_ID), true)
  assert.equal(isCanonicalSessionId(SESSION_ID.toUpperCase()), false)
  assert.equal(isFullGitCommit(BASE_COMMIT), true)
  assert.equal(isFullGitCommit(BASE_COMMIT.slice(0, 12)), false)
  assert.equal(isSha256(HASH_A), true)
  assert.equal(isSha256(HASH_A.slice(0, 40)), false)
})

test('Session-Erzeugung bindet unveränderliche Identität und Basis', () => {
  const created = createEditorSession({
    id: SESSION_ID,
    baseCommit: BASE_COMMIT,
    createdBy: 'user-1',
    requestSummary: '  Kleine Änderung  ',
    createdAt: 1_000
  })

  assert.equal(created.session.id, SESSION_ID)
  assert.equal(created.session.baseCommit, BASE_COMMIT)
  assert.equal(created.session.status, S.CREATED)
  assert.equal(created.session.version, 0)
  assert.equal(created.session.requestSummary, 'Kleine Änderung')
  assert.equal(created.event.type, 'SESSION_CREATED')
  assert.equal(created.event.fromStatus, null)
  assert.equal(created.event.toStatus, S.CREATED)
  assert.equal(Object.isFrozen(created), true)
  assert.equal(Object.isFrozen(created.session), true)
  assert.equal(Object.isFrozen(created.event.metadata), true)

  assert.throws(() => {
    created.session.id = OTHER_SESSION_ID
  }, TypeError)

  assert.throws(
    () => createEditorSession({
      id: 'edit-1',
      baseCommit: BASE_COMMIT,
      createdBy: 'user-1',
      createdAt: 1_000
    }),
    expectDomainCode(E3_FAILURE_CODE.INVALID_SESSION_ID)
  )
  assert.throws(
    () => createEditorSession({
      id: SESSION_ID,
      baseCommit: BASE_COMMIT.slice(0, 12),
      createdBy: 'user-1',
      createdAt: 1_000
    }),
    expectDomainCode(E3_FAILURE_CODE.INVALID_BASE_COMMIT)
  )
})

test('Transitionstabelle enthält exakt alle freigegebenen V1-Kanten', () => {
  const expected = new Map([
    [`${S.CREATED}:${C.START_PROVISIONING}`, [S.PROVISIONING]],
    [`${S.PROVISIONING}:${C.FINISH_PROVISIONING}`, [S.EDITING]],
    [`${S.EDITING}:${C.RECORD_MUTATION}`, [S.EDITING]],
    [`${S.READY_FOR_REVIEW}:${C.RECORD_MUTATION}`, [S.EDITING]],
    [`${S.APPROVED}:${C.RECORD_MUTATION}`, [S.EDITING]],
    [`${S.EDITING}:${C.START_VALIDATION}`, [S.VALIDATING]],
    [`${S.VALIDATING}:${C.RECORD_VALIDATION_FAILURE}`, [S.EDITING]],
    [`${S.VALIDATING}:${C.MARK_READY_FOR_REVIEW}`, [S.READY_FOR_REVIEW]],
    [`${S.READY_FOR_REVIEW}:${C.REOPEN_FOR_EDITING}`, [S.EDITING]],
    [`${S.APPROVED}:${C.REOPEN_FOR_EDITING}`, [S.EDITING]],
    [`${S.READY_FOR_REVIEW}:${C.APPROVE}`, [S.APPROVED]],
    [`${S.APPROVED}:${C.START_EXPORT}`, [S.EXPORTING]],
    [`${S.EXPORTING}:${C.FINISH_EXPORT}`, [S.EXPORTED]],
    [`${S.EXPORTED}:${C.COMPLETE}`, [S.COMPLETED]]
  ])

  for (const status of [
    S.CREATED,
    S.PROVISIONING,
    S.EDITING,
    S.VALIDATING,
    S.READY_FOR_REVIEW,
    S.APPROVED,
    S.EXPORTING,
    S.EXPORTED,
    S.RECOVERING,
    S.STALE
  ]) {
    expected.set(`${status}:${C.FAIL}`, [S.FAILED])
  }

  for (const status of [
    S.CREATED,
    S.PROVISIONING,
    S.EDITING,
    S.VALIDATING,
    S.READY_FOR_REVIEW,
    S.APPROVED,
    S.EXPORTING,
    S.RECOVERING,
    S.STALE
  ]) {
    expected.set(`${status}:${C.CANCEL}`, [S.CANCELLED])
  }

  for (const status of [
    S.PROVISIONING,
    S.EDITING,
    S.VALIDATING,
    S.EXPORTING
  ]) {
    expected.set(`${status}:${C.MARK_STALE}`, [S.STALE])
  }

  for (const status of [
    S.PROVISIONING,
    S.VALIDATING,
    S.EXPORTING,
    S.STALE
  ]) {
    expected.set(`${status}:${C.START_RECOVERY}`, [S.RECOVERING])
  }

  for (const status of [
    S.PROVISIONING,
    S.EDITING,
    S.VALIDATING,
    S.READY_FOR_REVIEW,
    S.APPROVED,
    S.EXPORTING,
    S.EXPORTED,
    S.RECOVERING,
    S.STALE
  ]) {
    expected.set(`${status}:${C.MARK_CONFLICTED}`, [S.CONFLICTED])
  }

  expected.set(`${S.RECOVERING}:${C.FINISH_RECOVERY}`, [
    S.EDITING,
    S.READY_FOR_REVIEW,
    S.FAILED,
    S.CANCELLED,
    S.STALE,
    S.CONFLICTED
  ])

  for (const status of E3_SESSION_STATUSES) {
    for (const commandType of E3_SESSION_COMMANDS) {
      const targets = allowedSessionTargets(status, commandType)
      const expectedTargets =
        expected.get(`${status}:${commandType}`) || []

      assert.deepEqual(
        targets,
        expectedTargets,
        `${status} + ${commandType}`
      )

      for (const target of E3_SESSION_STATUSES) {
        assert.equal(
          isSessionTransitionAllowed(
            status,
            commandType,
            target
          ),
          expectedTargets.includes(target),
          `${status} + ${commandType} -> ${target}`
        )
      }
    }
  }
})

test('jede verbotene V1-Kombination wird ohne Zustandsänderung abgewiesen', () => {
  for (const status of E3_SESSION_STATUSES) {
    for (const commandType of E3_SESSION_COMMANDS) {
      if (E3_RESERVED_SESSION_COMMANDS.includes(commandType)) {
        continue
      }
      if (allowedSessionTargets(status, commandType).length > 0) {
        continue
      }

      const session = arbitrarySession(status)
      const attempted = command(session, commandType, {
        recoveryStatus: S.EDITING
      })

      assert.throws(
        () => transitionEditorSession(
          session,
          attempted,
          { currentLease: LEASE }
        ),
        expectDomainCode(E3_FAILURE_CODE.INVALID_TRANSITION),
        `${status} + ${commandType}`
      )
      assert.equal(session.status, status)
      assert.equal(session.version, 12)
    }
  }
})

test('vollständiger V1-Hauptpfad bindet Review, Freigabe und Export', () => {
  let session = createSession()
  const events = []

  const step = (type, overrides) => {
    const result = apply(session, type, overrides)
    session = result.session
    events.push(result.event)
  }

  step(C.START_PROVISIONING)
  step(C.FINISH_PROVISIONING)
  step(C.RECORD_MUTATION)
  step(C.START_VALIDATION)
  step(C.MARK_READY_FOR_REVIEW, { candidate: CANDIDATE })
  step(C.APPROVE, { binding: approvalBinding(session) })
  step(C.START_EXPORT)
  step(C.FINISH_EXPORT, { exportSha256: HASH_D })
  step(C.COMPLETE)

  assert.equal(session.status, S.COMPLETED)
  assert.equal(session.version, 9)
  assert.equal(session.id, SESSION_ID)
  assert.equal(session.baseCommit, BASE_COMMIT)
  assert.equal(session.candidate.patchSha256, HASH_B)
  assert.equal(session.approval.sessionId, SESSION_ID)
  assert.equal(session.approval.baseCommit, BASE_COMMIT)
  assert.equal(session.approval.patchSha256, HASH_B)
  assert.equal(session.approval.approvedBy, 'user-1')
  assert.equal(session.exportArtifact.sha256, HASH_D)
  assert.equal(events.length, 9)
  assert.deepEqual(
    events.map(event => event.versionAfter),
    [1, 2, 3, 4, 5, 6, 7, 8, 9]
  )
  assert.equal(events.at(-1).type, 'SESSION_COMPLETED')
  assert.equal(
    events.every(event => event.sessionId === SESSION_ID),
    true
  )
})

test('Mutation aus Review oder Approval verwirft alle gebundenen Nachweise', () => {
  const reviewed = toReview()
  const reviewedMutation = apply(
    reviewed,
    C.RECORD_MUTATION
  )

  assert.equal(reviewedMutation.session.status, S.EDITING)
  assert.equal(reviewedMutation.session.candidate, null)
  assert.equal(reviewedMutation.session.approval, null)
  assert.equal(reviewedMutation.session.exportArtifact, null)
  assert.equal(
    reviewedMutation.event.metadata.invalidatedReview,
    true
  )

  const approved = toApproved()
  const approvedMutation = apply(
    approved,
    C.RECORD_MUTATION
  )

  assert.equal(approvedMutation.session.status, S.EDITING)
  assert.equal(approvedMutation.session.candidate, null)
  assert.equal(approvedMutation.session.approval, null)
  assert.equal(
    approvedMutation.event.metadata.invalidatedApproval,
    true
  )

  const reopened = apply(approved, C.REOPEN_FOR_EDITING)
  assert.equal(reopened.session.candidate, null)
  assert.equal(reopened.session.approval, null)
})

test('jede Abweichung der Approval-Bindung wird einzeln abgewiesen', () => {
  const reviewed = toReview()
  const valid = approvalBinding(reviewed)
  const changedValues = {
    sessionId: OTHER_SESSION_ID,
    baseCommit: OTHER_COMMIT,
    candidateManifestSha256: HASH_D,
    patchSha256: HASH_D,
    validationManifestSha256: HASH_D,
    pathPolicyVersion: 'paths-v2',
    profileSetVersion: 'profiles-v2'
  }

  for (const [field, changedValue] of Object.entries(changedValues)) {
    assert.throws(
      () => apply(reviewed, C.APPROVE, {
        binding: {
          ...valid,
          [field]: changedValue
        }
      }),
      expectDomainCode(E3_FAILURE_CODE.HASH_BINDING_MISMATCH),
      field
    )
    assert.equal(reviewed.status, S.READY_FOR_REVIEW)
    assert.equal(reviewed.approval, null)
  }
})

test('bereits gespeicherte manipulierte Approval- oder Exportdaten werden abgewiesen', () => {
  const approved = toApproved()
  const tamperedApproval = Object.freeze({
    ...approved,
    approval: Object.freeze({
      ...approved.approval,
      patchSha256: HASH_D
    })
  })

  assert.throws(
    () => apply(tamperedApproval, C.START_EXPORT),
    expectDomainCode(E3_FAILURE_CODE.HASH_BINDING_MISMATCH)
  )

  let exported = apply(
    approved,
    C.START_EXPORT
  ).session
  exported = apply(exported, C.FINISH_EXPORT, {
    exportSha256: HASH_D
  }).session

  const tamperedExport = Object.freeze({
    ...exported,
    exportArtifact: Object.freeze({
      ...exported.exportArtifact,
      sha256: 'not-a-hash'
    })
  })

  assert.throws(
    () => apply(tamperedExport, C.COMPLETE),
    expectDomainCode(E3_FAILURE_CODE.INVALID_COMMAND_DATA)
  )
})

test('veraltete Version, Lease oder Fencing-Token werden fail-closed abgewiesen', () => {
  const session = createSession()
  const valid = command(session, C.START_PROVISIONING)

  assert.throws(
    () => transitionEditorSession(
      session,
      { ...valid, expectedVersion: 99 },
      { currentLease: LEASE }
    ),
    expectDomainCode(E3_FAILURE_CODE.STALE_VERSION)
  )

  assert.throws(
    () => transitionEditorSession(session, valid),
    expectDomainCode(E3_FAILURE_CODE.LEASE_REQUIRED)
  )

  assert.throws(
    () => transitionEditorSession(
      session,
      { ...valid, leaseOwner: 'old-worker' },
      { currentLease: LEASE }
    ),
    expectDomainCode(E3_FAILURE_CODE.LEASE_OWNER_MISMATCH)
  )

  assert.throws(
    () => transitionEditorSession(
      session,
      { ...valid, fencingToken: 6 },
      { currentLease: LEASE }
    ),
    expectDomainCode(E3_FAILURE_CODE.STALE_FENCING_TOKEN)
  )

  assert.throws(
    () => transitionEditorSession(
      session,
      { ...valid, sessionId: OTHER_SESSION_ID },
      { currentLease: LEASE }
    ),
    expectDomainCode(E3_FAILURE_CODE.SESSION_ID_MISMATCH)
  )

  assert.equal(session.status, S.CREATED)
  assert.equal(session.version, 0)
})

test('Recovery ist zielgebunden und produktive Apply-/Revert-Befehle bleiben deaktiviert', () => {
  let session = toEditing()
  session = apply(session, C.MARK_STALE).session
  session = apply(session, C.START_RECOVERY).session

  const recovered = apply(session, C.FINISH_RECOVERY, {
    recoveryStatus: S.EDITING
  })
  assert.equal(recovered.session.status, S.EDITING)
  assert.equal(recovered.event.metadata.recoveryStatus, S.EDITING)

  assert.throws(
    () => apply(session, C.FINISH_RECOVERY, {
      recoveryStatus: S.COMPLETED
    }),
    expectDomainCode(E3_FAILURE_CODE.INVALID_TRANSITION)
  )

  const approved = toApproved()
  assert.throws(
    () => apply(approved, C.START_APPLY),
    expectDomainCode(E3_FAILURE_CODE.APPLY_DISABLED)
  )
  assert.throws(
    () => apply(approved, C.START_REVERT),
    expectDomainCode(E3_FAILURE_CODE.APPLY_DISABLED)
  )
})

test('Core-Module enthalten keinen Datei-, DB-, Netzwerk- oder Prozesszugriff', async () => {
  const sources = await Promise.all([
    readFile(
      new URL(
        '../server/e3/core/contracts.js',
        import.meta.url
      ),
      'utf8'
    ),
    readFile(
      new URL(
        '../server/e3/core/sessionState.js',
        import.meta.url
      ),
      'utf8'
    )
  ])

  for (const source of sources) {
    assert.doesNotMatch(
      source,
      /node:(?:fs|child_process|net|http|https|worker_threads)/
    )
    assert.doesNotMatch(
      source,
      /(?:better-sqlite3|server\/db|shell:\s*true|spawn\s*\()/
    )
  }
})
