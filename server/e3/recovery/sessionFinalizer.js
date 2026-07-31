import {
  E3_SESSION_COMMAND,
  E3_SESSION_STATUS,
  assertCanonicalSessionId,
  assertFencingToken,
  assertSafeToken,
  assertTimestamp,
  freezeDomainValue
} from '../core/contracts.js'
import {
  EditorRepository
} from '../persistence/editorRepository.js'
import {
  E3_RECOVERY_ERROR,
  E3RecoveryError
} from './errors.js'

function recoveryError(code, message, details = {}, cause) {
  throw new E3RecoveryError(
    code,
    message,
    details,
    cause ? { cause } : {}
  )
}

export class RecoverySessionFinalizer {
  constructor(database) {
    this.sessions = new EditorRepository(database)
  }

  completeExportedSession({
    sessionId,
    actorId,
    requestId,
    occurredAt,
    leaseOwner,
    fencingToken
  }) {
    assertCanonicalSessionId(sessionId)
    assertSafeToken(actorId, 'actorId')
    assertSafeToken(requestId, 'requestId', {
      minLength: 8,
      maxLength: 160
    })
    assertTimestamp(occurredAt, 'occurredAt')
    assertSafeToken(leaseOwner, 'leaseOwner')
    assertFencingToken(fencingToken)

    const session = this.sessions.getSession(sessionId)
    if (!session) {
      recoveryError(
        E3_RECOVERY_ERROR.SESSION_FINALIZATION_FAILED,
        'Recovery session does not exist'
      )
    }
    if (session.status === E3_SESSION_STATUS.COMPLETED) {
      return freezeDomainValue({
        session,
        event: null,
        replayed: true
      })
    }
    if (session.status !== E3_SESSION_STATUS.EXPORTED) {
      recoveryError(
        E3_RECOVERY_ERROR.SESSION_FINALIZATION_FAILED,
        'Only an exported session can be finalized after cleanup',
        { status: session.status }
      )
    }

    try {
      return this.sessions.transitionSession({
        type: E3_SESSION_COMMAND.COMPLETE,
        sessionId,
        expectedVersion: session.version,
        actorId,
        requestId,
        occurredAt,
        leaseOwner,
        fencingToken
      })
    } catch (cause) {
      recoveryError(
        E3_RECOVERY_ERROR.SESSION_FINALIZATION_FAILED,
        'Exported session finalization failed',
        {},
        cause
      )
    }
  }
}
