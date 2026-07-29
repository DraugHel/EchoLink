import {
  E3DomainError,
  E3_EVENT_TYPE,
  E3_FAILURE_CODE,
  E3_RESERVED_SESSION_COMMANDS,
  E3_SESSION_COMMAND,
  E3_SESSION_STATUS,
  assertCanonicalSessionId,
  assertFencingToken,
  assertFullGitCommit,
  assertSafeToken,
  assertSha256,
  assertTimestamp,
  assertVersion,
  freezeDomainValue,
  isE3FailureCode,
  isE3SessionCommand,
  isE3SessionStatus
} from './contracts.js'

const S = E3_SESSION_STATUS
const C = E3_SESSION_COMMAND

const STATIC_TRANSITIONS = Object.freeze({
  [C.START_PROVISIONING]: Object.freeze({
    [S.CREATED]: S.PROVISIONING
  }),
  [C.FINISH_PROVISIONING]: Object.freeze({
    [S.PROVISIONING]: S.EDITING
  }),
  [C.RECORD_MUTATION]: Object.freeze({
    [S.EDITING]: S.EDITING,
    [S.READY_FOR_REVIEW]: S.EDITING,
    [S.APPROVED]: S.EDITING
  }),
  [C.START_VALIDATION]: Object.freeze({
    [S.EDITING]: S.VALIDATING
  }),
  [C.RECORD_VALIDATION_FAILURE]: Object.freeze({
    [S.VALIDATING]: S.EDITING
  }),
  [C.MARK_READY_FOR_REVIEW]: Object.freeze({
    [S.VALIDATING]: S.READY_FOR_REVIEW
  }),
  [C.REOPEN_FOR_EDITING]: Object.freeze({
    [S.READY_FOR_REVIEW]: S.EDITING,
    [S.APPROVED]: S.EDITING
  }),
  [C.APPROVE]: Object.freeze({
    [S.READY_FOR_REVIEW]: S.APPROVED
  }),
  [C.START_EXPORT]: Object.freeze({
    [S.APPROVED]: S.EXPORTING
  }),
  [C.FINISH_EXPORT]: Object.freeze({
    [S.EXPORTING]: S.EXPORTED
  }),
  [C.COMPLETE]: Object.freeze({
    [S.EXPORTED]: S.COMPLETED
  }),
  [C.FAIL]: Object.freeze({
    [S.CREATED]: S.FAILED,
    [S.PROVISIONING]: S.FAILED,
    [S.EDITING]: S.FAILED,
    [S.VALIDATING]: S.FAILED,
    [S.READY_FOR_REVIEW]: S.FAILED,
    [S.APPROVED]: S.FAILED,
    [S.EXPORTING]: S.FAILED,
    [S.EXPORTED]: S.FAILED,
    [S.RECOVERING]: S.FAILED,
    [S.STALE]: S.FAILED
  }),
  [C.CANCEL]: Object.freeze({
    [S.CREATED]: S.CANCELLED,
    [S.PROVISIONING]: S.CANCELLED,
    [S.EDITING]: S.CANCELLED,
    [S.VALIDATING]: S.CANCELLED,
    [S.READY_FOR_REVIEW]: S.CANCELLED,
    [S.APPROVED]: S.CANCELLED,
    [S.EXPORTING]: S.CANCELLED,
    [S.RECOVERING]: S.CANCELLED,
    [S.STALE]: S.CANCELLED
  }),
  [C.MARK_STALE]: Object.freeze({
    [S.PROVISIONING]: S.STALE,
    [S.EDITING]: S.STALE,
    [S.VALIDATING]: S.STALE,
    [S.EXPORTING]: S.STALE
  }),
  [C.START_RECOVERY]: Object.freeze({
    [S.PROVISIONING]: S.RECOVERING,
    [S.VALIDATING]: S.RECOVERING,
    [S.EXPORTING]: S.RECOVERING,
    [S.STALE]: S.RECOVERING
  }),
  [C.MARK_CONFLICTED]: Object.freeze({
    [S.PROVISIONING]: S.CONFLICTED,
    [S.EDITING]: S.CONFLICTED,
    [S.VALIDATING]: S.CONFLICTED,
    [S.READY_FOR_REVIEW]: S.CONFLICTED,
    [S.APPROVED]: S.CONFLICTED,
    [S.EXPORTING]: S.CONFLICTED,
    [S.EXPORTED]: S.CONFLICTED,
    [S.RECOVERING]: S.CONFLICTED,
    [S.STALE]: S.CONFLICTED
  })
})

const RECOVERY_TARGETS = Object.freeze([
  S.EDITING,
  S.READY_FOR_REVIEW,
  S.FAILED,
  S.CANCELLED,
  S.STALE,
  S.CONFLICTED
])

const EVENT_BY_COMMAND = Object.freeze({
  [C.START_PROVISIONING]: E3_EVENT_TYPE.PROVISIONING_STARTED,
  [C.FINISH_PROVISIONING]: E3_EVENT_TYPE.PROVISIONING_FINISHED,
  [C.RECORD_MUTATION]: E3_EVENT_TYPE.MUTATION_RECORDED,
  [C.START_VALIDATION]: E3_EVENT_TYPE.VALIDATION_STARTED,
  [C.RECORD_VALIDATION_FAILURE]: E3_EVENT_TYPE.VALIDATION_FAILED,
  [C.MARK_READY_FOR_REVIEW]: E3_EVENT_TYPE.REVIEW_READY,
  [C.REOPEN_FOR_EDITING]: E3_EVENT_TYPE.REVIEW_REOPENED,
  [C.APPROVE]: E3_EVENT_TYPE.SESSION_APPROVED,
  [C.START_EXPORT]: E3_EVENT_TYPE.EXPORT_STARTED,
  [C.FINISH_EXPORT]: E3_EVENT_TYPE.EXPORT_FINISHED,
  [C.COMPLETE]: E3_EVENT_TYPE.SESSION_COMPLETED,
  [C.FAIL]: E3_EVENT_TYPE.SESSION_FAILED,
  [C.CANCEL]: E3_EVENT_TYPE.SESSION_CANCELLED,
  [C.MARK_STALE]: E3_EVENT_TYPE.SESSION_STALE,
  [C.START_RECOVERY]: E3_EVENT_TYPE.RECOVERY_STARTED,
  [C.FINISH_RECOVERY]: E3_EVENT_TYPE.RECOVERY_FINISHED,
  [C.MARK_CONFLICTED]: E3_EVENT_TYPE.SESSION_CONFLICTED
})

function cleanText(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength)
}

function domainError(code, message, details) {
  throw new E3DomainError(code, message, details)
}

function validateStatusInvariants(session) {
  const requiresCandidate = [
    S.READY_FOR_REVIEW,
    S.APPROVED,
    S.EXPORTING,
    S.EXPORTED,
    S.COMPLETED
  ].includes(session.status)
  const requiresApproval = [
    S.APPROVED,
    S.EXPORTING,
    S.EXPORTED,
    S.COMPLETED
  ].includes(session.status)
  const requiresExport = [
    S.EXPORTED,
    S.COMPLETED
  ].includes(session.status)
  const forbidsFrozenState = [
    S.CREATED,
    S.PROVISIONING,
    S.EDITING,
    S.VALIDATING
  ].includes(session.status)

  if (requiresCandidate && !session.candidate) {
    domainError(
      E3_FAILURE_CODE.INVALID_SESSION,
      'Session status requires a frozen candidate'
    )
  }

  if (requiresApproval && !session.approval) {
    domainError(
      E3_FAILURE_CODE.INVALID_SESSION,
      'Session status requires an approval'
    )
  }

  if (requiresExport && !session.exportArtifact) {
    domainError(
      E3_FAILURE_CODE.INVALID_SESSION,
      'Session status requires a durable export artifact'
    )
  }

  if (
    session.status === S.READY_FOR_REVIEW &&
    (session.approval || session.exportArtifact)
  ) {
    domainError(
      E3_FAILURE_CODE.INVALID_SESSION,
      'Review-ready session cannot retain approval or export'
    )
  }

  if (
    [S.APPROVED, S.EXPORTING].includes(session.status) &&
    session.exportArtifact
  ) {
    domainError(
      E3_FAILURE_CODE.INVALID_SESSION,
      'Session cannot retain export evidence before export completion'
    )
  }

  if (
    forbidsFrozenState &&
    (session.candidate || session.approval || session.exportArtifact)
  ) {
    domainError(
      E3_FAILURE_CODE.INVALID_SESSION,
      'Editable session state contains stale frozen evidence'
    )
  }

  if (session.candidate) {
    validateCandidate(session.candidate)
  }

  if (session.approval) {
    validateApprovalBinding(session, session.approval)
    assertSafeToken(
      session.approval.approvedBy,
      'approval.approvedBy'
    )
    assertTimestamp(
      session.approval.approvedAt,
      'approval.approvedAt'
    )
  }

  if (session.exportArtifact) {
    assertSha256(
      session.exportArtifact.sha256,
      'exportArtifact.sha256'
    )
    assertTimestamp(
      session.exportArtifact.exportedAt,
      'exportArtifact.exportedAt'
    )
  }
}

function validateSession(session) {
  if (!session || typeof session !== 'object') {
    domainError(
      E3_FAILURE_CODE.INVALID_SESSION,
      'Session must be an object'
    )
  }

  assertCanonicalSessionId(session.id)
  assertFullGitCommit(session.baseCommit)
  assertVersion(session.version)

  if (!isE3SessionStatus(session.status)) {
    domainError(
      E3_FAILURE_CODE.INVALID_STATUS,
      'Session has an unknown status',
      { status: session.status }
    )
  }

  validateStatusInvariants(session)
  return session
}

function validateCommandEnvelope(session, command, currentLease) {
  if (!command || typeof command !== 'object') {
    domainError(
      E3_FAILURE_CODE.INVALID_COMMAND,
      'Command must be an object'
    )
  }

  if (!isE3SessionCommand(command.type)) {
    domainError(
      E3_FAILURE_CODE.INVALID_COMMAND,
      'Unknown session command',
      { commandType: command.type }
    )
  }

  if (E3_RESERVED_SESSION_COMMANDS.includes(command.type)) {
    domainError(
      E3_FAILURE_CODE.APPLY_DISABLED,
      'Productive apply and revert commands are disabled in E3 V1',
      { commandType: command.type }
    )
  }

  assertCanonicalSessionId(command.sessionId)

  if (command.sessionId !== session.id) {
    domainError(
      E3_FAILURE_CODE.SESSION_ID_MISMATCH,
      'Command is bound to a different session'
    )
  }

  assertVersion(command.expectedVersion, 'expectedVersion')

  if (command.expectedVersion !== session.version) {
    domainError(
      E3_FAILURE_CODE.STALE_VERSION,
      'Session version is stale',
      {
        expectedVersion: command.expectedVersion,
        currentVersion: session.version
      }
    )
  }

  assertSafeToken(command.actorId, 'actorId')
  assertSafeToken(command.requestId, 'requestId', {
    minLength: 8,
    maxLength: 160
  })
  assertTimestamp(command.occurredAt)

  if (!currentLease || typeof currentLease !== 'object') {
    domainError(
      E3_FAILURE_CODE.LEASE_REQUIRED,
      'A current session lease is required'
    )
  }

  assertSafeToken(currentLease.owner, 'currentLease.owner')
  assertFencingToken(
    currentLease.fencingToken,
    'currentLease.fencingToken'
  )
  assertSafeToken(command.leaseOwner, 'leaseOwner')
  assertFencingToken(command.fencingToken)

  if (command.leaseOwner !== currentLease.owner) {
    domainError(
      E3_FAILURE_CODE.LEASE_OWNER_MISMATCH,
      'Session lease belongs to a different owner'
    )
  }

  if (command.fencingToken !== currentLease.fencingToken) {
    domainError(
      E3_FAILURE_CODE.STALE_FENCING_TOKEN,
      'Session fencing token is stale',
      {
        providedFencingToken: command.fencingToken,
        currentFencingToken: currentLease.fencingToken
      }
    )
  }
}

function transitionTarget(status, commandType, recoveryStatus) {
  if (commandType === C.FINISH_RECOVERY) {
    if (
      status === S.RECOVERING &&
      RECOVERY_TARGETS.includes(recoveryStatus)
    ) {
      return recoveryStatus
    }
    return null
  }

  return STATIC_TRANSITIONS[commandType]?.[status] ?? null
}

function clearFrozenState(session) {
  return {
    ...session,
    candidate: null,
    approval: null,
    exportArtifact: null,
    reviewReadyAt: null
  }
}

function validateCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    domainError(
      E3_FAILURE_CODE.CANDIDATE_REQUIRED,
      'A frozen candidate is required'
    )
  }

  return freezeDomainValue({
    candidateManifestSha256: assertSha256(
      candidate.candidateManifestSha256,
      'candidateManifestSha256'
    ),
    patchSha256: assertSha256(
      candidate.patchSha256,
      'patchSha256'
    ),
    validationManifestSha256: assertSha256(
      candidate.validationManifestSha256,
      'validationManifestSha256'
    ),
    pathPolicyVersion: assertSafeToken(
      candidate.pathPolicyVersion,
      'pathPolicyVersion'
    ),
    profileSetVersion: assertSafeToken(
      candidate.profileSetVersion,
      'profileSetVersion'
    )
  })
}

function validateApprovalBinding(session, binding) {
  if (!session.candidate) {
    domainError(
      E3_FAILURE_CODE.CANDIDATE_REQUIRED,
      'Approval requires a frozen candidate'
    )
  }

  if (!binding || typeof binding !== 'object') {
    domainError(
      E3_FAILURE_CODE.APPROVAL_REQUIRED,
      'Approval binding is required'
    )
  }

  const expected = {
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

  for (const [field, expectedValue] of Object.entries(expected)) {
    if (binding[field] !== expectedValue) {
      domainError(
        E3_FAILURE_CODE.HASH_BINDING_MISMATCH,
        `Approval binding does not match ${field}`,
        { field }
      )
    }
  }

  return expected
}

function validateFailure(command) {
  if (!isE3FailureCode(command.failureCode)) {
    domainError(
      E3_FAILURE_CODE.INVALID_COMMAND_DATA,
      'Failure command requires a stable failure code'
    )
  }

  return freezeDomainValue({
    code: command.failureCode,
    message: cleanText(command.failureMessage, 2_000),
    failedAt: command.occurredAt
  })
}

function eventMetadata(command, previous, next) {
  switch (command.type) {
    case C.RECORD_MUTATION:
    case C.REOPEN_FOR_EDITING:
      return {
        invalidatedReview: Boolean(previous.candidate),
        invalidatedApproval: Boolean(previous.approval),
        invalidatedExport: Boolean(previous.exportArtifact)
      }
    case C.MARK_READY_FOR_REVIEW:
      return {
        patchSha256: next.candidate.patchSha256,
        validationManifestSha256:
          next.candidate.validationManifestSha256
      }
    case C.APPROVE:
      return {
        patchSha256: next.approval.patchSha256,
        validationManifestSha256:
          next.approval.validationManifestSha256
      }
    case C.FINISH_EXPORT:
      return {
        exportSha256: next.exportArtifact.sha256
      }
    case C.FAIL:
    case C.MARK_CONFLICTED:
      return {
        failureCode: next.failure.code
      }
    case C.FINISH_RECOVERY:
      return {
        recoveryStatus: next.status
      }
    default:
      return {}
  }
}

function applyCommandData(session, command, targetStatus) {
  let next = {
    ...session,
    status: targetStatus,
    version: session.version + 1,
    updatedAt: command.occurredAt,
    failure: null
  }

  switch (command.type) {
    case C.RECORD_MUTATION:
    case C.REOPEN_FOR_EDITING:
      next = clearFrozenState(next)
      break
    case C.START_VALIDATION:
      next = clearFrozenState(next)
      break
    case C.RECORD_VALIDATION_FAILURE:
      next = clearFrozenState(next)
      next.failure = freezeDomainValue({
        code: E3_FAILURE_CODE.VALIDATION_FAILED,
        message: cleanText(command.failureMessage, 2_000),
        failedAt: command.occurredAt
      })
      break
    case C.MARK_READY_FOR_REVIEW:
      next.candidate = validateCandidate(command.candidate)
      next.approval = null
      next.exportArtifact = null
      next.reviewReadyAt = command.occurredAt
      break
    case C.APPROVE: {
      const binding = validateApprovalBinding(
        session,
        command.binding
      )
      next.approval = freezeDomainValue({
        ...binding,
        approvedBy: command.actorId,
        approvedAt: command.occurredAt
      })
      break
    }
    case C.FINISH_EXPORT:
      if (!session.approval) {
        domainError(
          E3_FAILURE_CODE.APPROVAL_REQUIRED,
          'Export completion requires a valid approval'
        )
      }
      next.exportArtifact = freezeDomainValue({
        sha256: assertSha256(
          command.exportSha256,
          'exportSha256'
        ),
        exportedAt: command.occurredAt
      })
      break
    case C.COMPLETE:
      if (!session.exportArtifact || !session.approval) {
        domainError(
          E3_FAILURE_CODE.APPROVAL_REQUIRED,
          'Completion requires approved durable export evidence'
        )
      }
      break
    case C.FAIL:
      next.failure = validateFailure(command)
      break
    case C.MARK_CONFLICTED:
      next.failure = freezeDomainValue({
        code: command.failureCode || E3_FAILURE_CODE.BASE_DIVERGED,
        message: cleanText(command.failureMessage, 2_000),
        failedAt: command.occurredAt
      })
      if (!isE3FailureCode(next.failure.code)) {
        domainError(
          E3_FAILURE_CODE.INVALID_COMMAND_DATA,
          'Conflict requires a stable failure code'
        )
      }
      break
    case C.FINISH_RECOVERY:
      if (targetStatus === S.READY_FOR_REVIEW && !session.candidate) {
        domainError(
          E3_FAILURE_CODE.CANDIDATE_REQUIRED,
          'Recovery cannot restore review without a candidate'
        )
      }
      if (
        targetStatus === S.FAILED ||
        targetStatus === S.CONFLICTED
      ) {
        next.failure = validateFailure(command)
      }
      if (targetStatus === S.READY_FOR_REVIEW) {
        next.approval = null
        next.exportArtifact = null
      }
      if (targetStatus === S.EDITING) {
        next = clearFrozenState(next)
      }
      break
    default:
      break
  }

  return freezeDomainValue(next)
}

export function createEditorSession({
  id,
  baseCommit,
  createdBy,
  requestSummary = '',
  createdAt
}) {
  assertCanonicalSessionId(id)
  assertFullGitCommit(baseCommit)
  assertSafeToken(createdBy, 'createdBy')
  assertTimestamp(createdAt, 'createdAt')

  const session = freezeDomainValue({
    id,
    status: S.CREATED,
    baseCommit,
    requestSummary: cleanText(requestSummary, 2_000),
    createdBy,
    createdAt,
    updatedAt: createdAt,
    version: 0,
    reviewReadyAt: null,
    candidate: null,
    approval: null,
    exportArtifact: null,
    failure: null
  })

  const event = freezeDomainValue({
    type: E3_EVENT_TYPE.SESSION_CREATED,
    sessionId: id,
    fromStatus: null,
    toStatus: S.CREATED,
    versionBefore: null,
    versionAfter: 0,
    actorId: createdBy,
    requestId: null,
    occurredAt: createdAt,
    metadata: {}
  })

  return freezeDomainValue({ session, event, replayed: false })
}

export function allowedSessionTargets(
  status,
  commandType
) {
  if (!isE3SessionStatus(status)) return Object.freeze([])
  if (!isE3SessionCommand(commandType)) return Object.freeze([])
  if (E3_RESERVED_SESSION_COMMANDS.includes(commandType)) {
    return Object.freeze([])
  }
  if (
    commandType === C.FINISH_RECOVERY &&
    status === S.RECOVERING
  ) {
    return RECOVERY_TARGETS
  }

  const target = STATIC_TRANSITIONS[commandType]?.[status]
  return Object.freeze(target ? [target] : [])
}

export function isSessionTransitionAllowed(
  status,
  commandType,
  targetStatus
) {
  const targets = allowedSessionTargets(status, commandType)
  return targetStatus === undefined
    ? targets.length > 0
    : targets.includes(targetStatus)
}

export function transitionEditorSession(
  session,
  command,
  { currentLease } = {}
) {
  validateSession(session)
  validateCommandEnvelope(session, command, currentLease)

  const targetStatus = transitionTarget(
    session.status,
    command.type,
    command.recoveryStatus
  )

  if (!targetStatus) {
    domainError(
      E3_FAILURE_CODE.INVALID_TRANSITION,
      'Session command is not allowed from the current status',
      {
        commandType: command.type,
        currentStatus: session.status,
        recoveryStatus: command.recoveryStatus ?? null
      }
    )
  }

  const nextSession = applyCommandData(
    session,
    command,
    targetStatus
  )
  const event = freezeDomainValue({
    type: EVENT_BY_COMMAND[command.type],
    sessionId: session.id,
    fromStatus: session.status,
    toStatus: nextSession.status,
    versionBefore: session.version,
    versionAfter: nextSession.version,
    actorId: command.actorId,
    requestId: command.requestId,
    occurredAt: command.occurredAt,
    metadata: eventMetadata(command, session, nextSession)
  })

  return freezeDomainValue({
    session: nextSession,
    event,
    replayed: false
  })
}
