import { createHash } from 'node:crypto'
import {
  E3_LEASE_RESOURCE_TYPE,
  E3_SESSION_STATUS,
  assertCanonicalSessionId,
  assertFencingToken,
  assertSafeToken,
  freezeDomainValue
} from '../core/contracts.js'
import { E3_EDITOR_LIMITS } from './contracts.js'
import {
  E3_PERSISTENCE_ERROR,
  E3PersistenceError
} from '../persistence/errors.js'

function fail(code, message, details = {}) {
  throw new E3PersistenceError(code, message, details)
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort()
      .filter(key => value[key] !== undefined)
      .map(key => [key, canonical(value[key])]))
  }
  return value
}

function json(value) {
  return JSON.stringify(canonical(value))
}

export function editorRequestSha256(request) {
  return createHash('sha256').update(json(request)).digest('hex')
}

function rowToIntent(row) {
  if (!row) return null
  return freezeDomainValue({
    id: row.id,
    sessionId: row.session_id,
    requestId: row.request_id,
    operationId: row.operation_id,
    sequence: row.sequence,
    state: row.state,
    type: row.operation_type,
    command: JSON.parse(row.command_json),
    requestMetadata: JSON.parse(row.request_metadata_json),
    requestSha256: row.request_sha256,
    pathBefore: row.path_before,
    pathAfter: row.path_after,
    preimageSha256: row.preimage_sha256,
    postimageSha256: row.postimage_sha256,
    changedBytes: row.changed_bytes,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    sessionOwner: row.session_owner,
    sessionFencingToken: row.session_fencing_token,
    workspaceOwner: row.workspace_owner,
    workspaceFencingToken: row.workspace_fencing_token,
    workspacePath: row.workspace_path,
    preparedAt: row.prepared_at,
    publishedAt: row.published_at,
    recordedAt: row.recorded_at,
    recoveryReason: row.recovery_reason
  })
}

export class OperationIntentRepository {
  constructor(database) {
    this.database = database
  }

  get(intentId) {
    assertCanonicalSessionId(intentId)
    return rowToIntent(this.database.prepare(`
      SELECT * FROM editor_operation_intents WHERE id = ?
    `).get(intentId))
  }

  getByRequest(sessionId, requestId) {
    assertCanonicalSessionId(sessionId)
    assertSafeToken(requestId, 'requestId', { minLength: 8, maxLength: 160 })
    return rowToIntent(this.database.prepare(`
      SELECT * FROM editor_operation_intents
      WHERE session_id = ? AND request_id = ?
    `).get(sessionId, requestId))
  }

  prepare({
    intentId,
    operationId,
    command,
    request,
    plan,
    sessionOwner,
    sessionFencingToken,
    workspaceOwner,
    workspaceFencingToken
  }) {
    assertCanonicalSessionId(intentId)
    assertCanonicalSessionId(operationId)
    assertCanonicalSessionId(command.sessionId)
    assertFencingToken(sessionFencingToken)
    assertFencingToken(workspaceFencingToken)
    assertSafeToken(sessionOwner, 'sessionOwner')
    assertSafeToken(workspaceOwner, 'workspaceOwner')
    const requestSha256 = editorRequestSha256(request)
    const metadata = {
      version: request.version,
      type: request.type,
      path: request.path ?? null,
      sourcePath: request.sourcePath ?? null,
      destinationPath: request.destinationPath ?? null,
      expectedSha256: request.expectedSha256 ?? null
    }

    return this.database.transaction(() => {
      const existing = this.getByRequest(command.sessionId, command.requestId)
      if (existing) {
        if (existing.requestSha256 !== requestSha256) {
          fail(
            E3_PERSISTENCE_ERROR.IDEMPOTENCY_CONFLICT,
            'Request ID was already bound to different editor input'
          )
        }
        return existing
      }
      const session = this.database.prepare(`
        SELECT status, version FROM editor_sessions WHERE id = ?
      `).get(command.sessionId)
      if (!session) {
        fail(E3_PERSISTENCE_ERROR.SESSION_NOT_FOUND, 'Session does not exist')
      }
      if (
        ![
          E3_SESSION_STATUS.EDITING,
          E3_SESSION_STATUS.READY_FOR_REVIEW,
          E3_SESSION_STATUS.APPROVED
        ].includes(session.status) ||
        session.version !== command.expectedVersion
      ) {
        fail(E3_PERSISTENCE_ERROR.OPTIMISTIC_CONFLICT,
          'Session is not at the expected editable version')
      }
      const workspace = this.assertCurrentOwnership({
        sessionId: command.sessionId,
        sessionOwner,
        sessionFencingToken,
        workspaceOwner,
        workspaceFencingToken,
        occurredAt: command.occurredAt
      })
      const totals = this.database.prepare(`
        SELECT COUNT(*) AS count, COALESCE(SUM(changed_bytes), 0) AS bytes
        FROM editor_operation_intents
        WHERE session_id = ? AND state <> 'RECOVERY_REQUIRED'
      `).get(command.sessionId)
      if (
        totals.count >= E3_EDITOR_LIMITS.maxMutationsPerSession ||
        totals.bytes + plan.changedBytes >
          E3_EDITOR_LIMITS.maxAggregateChangedBytes
      ) {
        fail(E3_PERSISTENCE_ERROR.INVALID_RECORD,
          'Session mutation quota exceeded')
      }
      const sequence = this.database.prepare(`
        SELECT COALESCE(MAX(sequence), 0) + 1 AS value
        FROM editor_operation_intents WHERE session_id = ?
      `).get(command.sessionId).value
      this.database.prepare(`
        INSERT INTO editor_operation_intents (
          id, session_id, request_id, operation_id, sequence, state,
          operation_type, command_json, request_metadata_json,
          request_sha256, path_before, path_after, preimage_sha256,
          postimage_sha256, changed_bytes, session_owner,
          session_fencing_token, workspace_owner,
          workspace_fencing_token, workspace_path, prepared_at
        ) VALUES (
          ?, ?, ?, ?, ?, 'PREPARED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?
        )
      `).run(
        intentId,
        command.sessionId,
        command.requestId,
        operationId,
        sequence,
        plan.type,
        json(command),
        json(metadata),
        requestSha256,
        plan.pathBefore,
        plan.pathAfter,
        plan.preimageSha256,
        plan.postimageSha256,
        plan.changedBytes,
        sessionOwner,
        sessionFencingToken,
        workspaceOwner,
        workspaceFencingToken,
        workspace.canonical_path,
        command.occurredAt
      )
      return this.get(intentId)
    }).immediate()
  }

  assertCurrentOwnership({
    sessionId,
    sessionOwner,
    sessionFencingToken,
    workspaceOwner,
    workspaceFencingToken,
    occurredAt
  }) {
    const sessionLease = this.database.prepare(`
      SELECT owner, fencing_token, expires_at FROM editor_leases
      WHERE resource_type = ? AND resource_key = ?
    `).get(E3_LEASE_RESOURCE_TYPE.SESSION, sessionId)
    const workspaceLease = this.database.prepare(`
      SELECT owner, fencing_token, expires_at FROM editor_leases
      WHERE resource_type = ? AND resource_key = ?
    `).get(E3_LEASE_RESOURCE_TYPE.WORKSPACE, sessionId)
    const workspace = this.database.prepare(`
      SELECT * FROM editor_workspaces WHERE session_id = ?
    `).get(sessionId)
    if (
      !sessionLease ||
      sessionLease.owner !== sessionOwner ||
      sessionLease.fencing_token !== sessionFencingToken ||
      sessionLease.expires_at <= occurredAt ||
      !workspaceLease ||
      workspaceLease.owner !== workspaceOwner ||
      workspaceLease.fencing_token !== workspaceFencingToken ||
      workspaceLease.expires_at <= occurredAt ||
      !workspace ||
      workspace.state !== 'READY' ||
      workspace.manager_owner !== workspaceOwner ||
      workspace.fencing_token !== workspaceFencingToken
    ) {
      fail(E3_PERSISTENCE_ERROR.LEASE_CONFLICT,
        'Session or workspace fencing ownership is stale')
    }
    return workspace
  }

  assertIntentOwnership(intent, occurredAt) {
    return this.assertCurrentOwnership({
      sessionId: intent.sessionId,
      sessionOwner: intent.sessionOwner,
      sessionFencingToken: intent.sessionFencingToken,
      workspaceOwner: intent.workspaceOwner,
      workspaceFencingToken: intent.workspaceFencingToken,
      occurredAt
    })
  }

  recordPreimage(intentId, artifact, createdAt) {
    this.database.prepare(`
      INSERT OR IGNORE INTO editor_operation_preimages
      (intent_id, sha256, storage_key, size_bytes, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      intentId,
      artifact.sha256,
      artifact.storageKey,
      artifact.sizeBytes,
      createdAt
    )
  }

  markPublished(intentId, result, publishedAt) {
    const intent = this.get(intentId)
    if (!intent || intent.state !== 'PREPARED') {
      fail(E3_PERSISTENCE_ERROR.INVALID_RECORD,
        'Only PREPARED intent can be published')
    }
    if (
      result.preimageSha256 !== intent.preimageSha256 ||
      result.postimageSha256 !== intent.postimageSha256
    ) {
      fail(E3_PERSISTENCE_ERROR.INVALID_RECORD,
        'Published filesystem result differs from plan')
    }
    const update = this.database.prepare(`
      UPDATE editor_operation_intents
      SET state = 'PUBLISHED', result_json = ?, published_at = ?
      WHERE id = ? AND state = 'PREPARED'
    `).run(json(result), publishedAt, intentId)
    if (update.changes !== 1) {
      fail(E3_PERSISTENCE_ERROR.OPTIMISTIC_CONFLICT,
        'Intent changed before publication record')
    }
    return this.get(intentId)
  }

  markRecoveryRequired(intentId, reason) {
    this.database.prepare(`
      UPDATE editor_operation_intents
      SET state = 'RECOVERY_REQUIRED', recovery_reason = ?
      WHERE id = ? AND state IN ('PREPARED', 'PUBLISHED')
    `).run(String(reason).slice(0, 2000), intentId)
    return this.get(intentId)
  }
}
