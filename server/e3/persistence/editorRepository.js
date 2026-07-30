import { createHash } from 'node:crypto'
import {
  E3_ARTIFACT_TYPES,
  E3_LEASE_RESOURCE_TYPE,
  E3_LEASE_RESOURCE_TYPES,
  E3_OPERATION_TYPES,
  E3_SESSION_COMMAND,
  E3_VALIDATION_STATUSES,
  assertCanonicalSessionId,
  assertFencingToken,
  assertSafeToken,
  assertSha256,
  assertTimestamp,
  freezeDomainValue
} from '../core/contracts.js'
import {
  createEditorSession,
  transitionEditorSession
} from '../core/sessionState.js'
import {
  E3_PERSISTENCE_ERROR,
  E3PersistenceError
} from './errors.js'

function persistenceError(code, message, details = {}) {
  throw new E3PersistenceError(code, message, details)
}

function cleanObject(value) {
  if (Array.isArray(value)) {
    return value.map(cleanObject)
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter(key => value[key] !== undefined)
        .map(key => [key, cleanObject(value[key])])
    )
  }
  return value
}

function canonicalJson(value) {
  return JSON.stringify(cleanObject(value))
}

function requestChecksum(command, operation) {
  return createHash('sha256')
    .update(canonicalJson({ command, operation }))
    .digest('hex')
}

function assertPlainObject(value, fieldName) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    persistenceError(
      E3_PERSISTENCE_ERROR.INVALID_RECORD,
      `${fieldName} must be an object`,
      { fieldName }
    )
  }
  return value
}

function assertPositiveInteger(value, fieldName) {
  if (!Number.isSafeInteger(value) || value < 1) {
    persistenceError(
      E3_PERSISTENCE_ERROR.INVALID_RECORD,
      `${fieldName} must be a positive integer`,
      { fieldName }
    )
  }
  return value
}

function assertEnum(value, values, fieldName) {
  if (!values.includes(value)) {
    persistenceError(
      E3_PERSISTENCE_ERROR.INVALID_RECORD,
      `${fieldName} is not registered`,
      { fieldName, value }
    )
  }
  return value
}

function nullableText(value, fieldName, maxLength = 4096) {
  if (value === null || value === undefined) return null
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value.includes('\0')
  ) {
    persistenceError(
      E3_PERSISTENCE_ERROR.INVALID_RECORD,
      `${fieldName} is invalid`,
      { fieldName }
    )
  }
  return value
}

function rowToSession(row) {
  if (!row) return null

  const candidate = row.candidate_manifest_sha256
    ? {
        candidateManifestSha256:
          row.candidate_manifest_sha256,
        patchSha256: row.patch_sha256,
        validationManifestSha256:
          row.validation_manifest_sha256,
        pathPolicyVersion: row.path_policy_version,
        profileSetVersion: row.profile_set_version
      }
    : null
  const approval = row.approved_at === null
    ? null
    : {
        sessionId: row.id,
        baseCommit: row.base_commit,
        ...candidate,
        approvedBy: row.approved_by,
        approvedAt: row.approved_at
      }
  const exportArtifact = row.exported_at === null
    ? null
    : {
        sha256: row.export_sha256,
        exportedAt: row.exported_at
      }
  const failure = row.failed_at === null
    ? null
    : {
        code: row.failure_code,
        message: row.failure_message,
        failedAt: row.failed_at
      }

  return freezeDomainValue({
    id: row.id,
    status: row.status,
    baseCommit: row.base_commit,
    requestSummary: row.request_summary,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
    reviewReadyAt: row.review_ready_at,
    candidate,
    approval,
    exportArtifact,
    failure
  })
}

function rowToEvent(row) {
  if (!row) return null
  return freezeDomainValue({
    id: row.id,
    sequence: row.sequence,
    type: row.event_type,
    sessionId: row.session_id,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    versionBefore: row.version_before,
    versionAfter: row.version_after,
    actorId: row.actor_id,
    requestId: row.request_id,
    occurredAt: row.created_at,
    metadata: JSON.parse(row.metadata_json)
  })
}

function rowToLease(row) {
  if (!row) return null
  return freezeDomainValue({
    resourceType: row.resource_type,
    resourceKey: row.resource_key,
    owner: row.owner,
    acquiredAt: row.acquired_at,
    heartbeatAt: row.heartbeat_at,
    expiresAt: row.expires_at,
    fencingToken: row.fencing_token
  })
}

function assertLeaseInput({
  resourceType,
  resourceKey,
  owner,
  occurredAt,
  expiresAt
}) {
  assertEnum(
    resourceType,
    E3_LEASE_RESOURCE_TYPES,
    'resourceType'
  )
  assertSafeToken(resourceKey, 'resourceKey')
  assertSafeToken(owner, 'owner')
  assertTimestamp(occurredAt, 'occurredAt')
  assertTimestamp(expiresAt, 'expiresAt')
  if (expiresAt <= occurredAt) {
    persistenceError(
      E3_PERSISTENCE_ERROR.INVALID_RECORD,
      'Lease expiry must be after its heartbeat'
    )
  }
}

function validateOperation(operation, command) {
  assertPlainObject(operation, 'operation')
  assertCanonicalSessionId(operation.id)
  if (operation.sessionId !== command.sessionId) {
    persistenceError(
      E3_PERSISTENCE_ERROR.INVALID_RECORD,
      'Operation belongs to a different session'
    )
  }
  assertPositiveInteger(operation.sequence, 'operation.sequence')
  assertEnum(
    operation.type,
    E3_OPERATION_TYPES,
    'operation.type'
  )
  const pathBefore = nullableText(
    operation.pathBefore,
    'operation.pathBefore'
  )
  const pathAfter = nullableText(
    operation.pathAfter,
    'operation.pathAfter'
  )
  if (pathBefore === null && pathAfter === null) {
    persistenceError(
      E3_PERSISTENCE_ERROR.INVALID_RECORD,
      'Operation requires a before or after path'
    )
  }
  const preimageSha256 = operation.preimageSha256 == null
    ? null
    : assertSha256(
        operation.preimageSha256,
        'operation.preimageSha256'
      )
  const postimageSha256 = operation.postimageSha256 == null
    ? null
    : assertSha256(
        operation.postimageSha256,
        'operation.postimageSha256'
      )
  assertPlainObject(operation.parameters ?? {}, 'operation.parameters')

  return {
    id: operation.id,
    sessionId: operation.sessionId,
    sequence: operation.sequence,
    type: operation.type,
    pathBefore,
    pathAfter,
    preimageSha256,
    postimageSha256,
    parametersJson: canonicalJson(operation.parameters ?? {}),
    actorId: command.actorId,
    requestId: command.requestId,
    createdAt: command.occurredAt
  }
}

export class EditorRepository {
  constructor(database, {
    faultInjector = () => {}
  } = {}) {
    this.database = database
    this.faultInjector = faultInjector
  }

  createSession({
    id,
    baseCommit,
    createdBy,
    requestSummary = '',
    createdAt,
    leaseOwner,
    leaseExpiresAt
  }) {
    const created = createEditorSession({
      id,
      baseCommit,
      createdBy,
      requestSummary,
      createdAt
    })
    assertLeaseInput({
      resourceType: E3_LEASE_RESOURCE_TYPE.SESSION,
      resourceKey: id,
      owner: leaseOwner,
      occurredAt: createdAt,
      expiresAt: leaseExpiresAt
    })

    const transaction = this.database.transaction(() => {
      this.#insertSession(created.session)
      this.faultInjector('create.after_session')
      const eventId = this.#insertEvent(created.event)
      this.faultInjector('create.after_event')
      this.database.prepare(`
        INSERT INTO editor_leases (
          resource_type,
          resource_key,
          owner,
          acquired_at,
          heartbeat_at,
          expires_at,
          fencing_token
        ) VALUES (?, ?, ?, ?, ?, ?, 1)
      `).run(
        E3_LEASE_RESOURCE_TYPE.SESSION,
        id,
        leaseOwner,
        createdAt,
        createdAt,
        leaseExpiresAt
      )

      return freezeDomainValue({
        ...created,
        event: {
          ...created.event,
          id: eventId,
          sequence: 0
        },
        lease: {
          resourceType: E3_LEASE_RESOURCE_TYPE.SESSION,
          resourceKey: id,
          owner: leaseOwner,
          acquiredAt: createdAt,
          heartbeatAt: createdAt,
          expiresAt: leaseExpiresAt,
          fencingToken: 1
        }
      })
    })

    return transaction.immediate()
  }

  getSession(sessionId) {
    assertCanonicalSessionId(sessionId)
    const row = this.database.prepare(`
      SELECT *
      FROM editor_sessions
      WHERE id = ?
    `).get(sessionId)
    return rowToSession(row)
  }

  listEvents(sessionId) {
    assertCanonicalSessionId(sessionId)
    return Object.freeze(
      this.database.prepare(`
        SELECT *
        FROM editor_events
        WHERE session_id = ?
        ORDER BY sequence
      `).all(sessionId).map(rowToEvent)
    )
  }

  getLease(resourceType, resourceKey) {
    assertEnum(
      resourceType,
      E3_LEASE_RESOURCE_TYPES,
      'resourceType'
    )
    assertSafeToken(resourceKey, 'resourceKey')
    return rowToLease(this.database.prepare(`
      SELECT *
      FROM editor_leases
      WHERE resource_type = ? AND resource_key = ?
    `).get(resourceType, resourceKey))
  }

  claimLease({
    resourceType,
    resourceKey,
    owner,
    occurredAt,
    expiresAt,
    expectedFencingToken = null,
    previousOwnerConfirmedDead = false
  }) {
    assertLeaseInput({
      resourceType,
      resourceKey,
      owner,
      occurredAt,
      expiresAt
    })

    const transaction = this.database.transaction(() => {
      const current = this.getLease(resourceType, resourceKey)
      if (!current) {
        if (expectedFencingToken !== null) {
          persistenceError(
            E3_PERSISTENCE_ERROR.LEASE_CONFLICT,
            'Cannot fence a lease that does not exist'
          )
        }
        this.database.prepare(`
          INSERT INTO editor_leases (
            resource_type,
            resource_key,
            owner,
            acquired_at,
            heartbeat_at,
            expires_at,
            fencing_token
          ) VALUES (?, ?, ?, ?, ?, ?, 1)
        `).run(
          resourceType,
          resourceKey,
          owner,
          occurredAt,
          occurredAt,
          expiresAt
        )
        return this.getLease(resourceType, resourceKey)
      }

      assertFencingToken(
        expectedFencingToken,
        'expectedFencingToken'
      )
      if (expectedFencingToken !== current.fencingToken) {
        persistenceError(
          E3_PERSISTENCE_ERROR.LEASE_CONFLICT,
          'Lease fencing token changed',
          {
            expectedFencingToken,
            currentFencingToken: current.fencingToken
          }
        )
      }
      if (
        owner !== current.owner &&
        previousOwnerConfirmedDead !== true
      ) {
        persistenceError(
          E3_PERSISTENCE_ERROR.LEASE_CONFLICT,
          'Lease takeover requires independent owner-death evidence'
        )
      }
      if (occurredAt < current.heartbeatAt) {
        persistenceError(
          E3_PERSISTENCE_ERROR.LEASE_CONFLICT,
          'Lease claim timestamp is older than its heartbeat'
        )
      }

      const nextToken = current.fencingToken + 1
      const update = this.database.prepare(`
        UPDATE editor_leases
        SET
          owner = ?,
          acquired_at = ?,
          heartbeat_at = ?,
          expires_at = ?,
          fencing_token = ?
        WHERE
          resource_type = ?
          AND resource_key = ?
          AND fencing_token = ?
      `).run(
        owner,
        occurredAt,
        occurredAt,
        expiresAt,
        nextToken,
        resourceType,
        resourceKey,
        current.fencingToken
      )
      if (update.changes !== 1) {
        persistenceError(
          E3_PERSISTENCE_ERROR.LEASE_CONFLICT,
          'Lease changed during claim'
        )
      }
      return this.getLease(resourceType, resourceKey)
    })

    return transaction.immediate()
  }

  renewLease({
    resourceType,
    resourceKey,
    owner,
    fencingToken,
    heartbeatAt,
    expiresAt
  }) {
    assertLeaseInput({
      resourceType,
      resourceKey,
      owner,
      occurredAt: heartbeatAt,
      expiresAt
    })
    assertFencingToken(fencingToken)

    const update = this.database.prepare(`
      UPDATE editor_leases
      SET heartbeat_at = ?, expires_at = ?
      WHERE
        resource_type = ?
        AND resource_key = ?
        AND owner = ?
        AND fencing_token = ?
        AND heartbeat_at <= ?
    `).run(
      heartbeatAt,
      expiresAt,
      resourceType,
      resourceKey,
      owner,
      fencingToken,
      heartbeatAt
    )
    if (update.changes !== 1) {
      persistenceError(
        E3_PERSISTENCE_ERROR.LEASE_CONFLICT,
        'Lease renewal did not match current ownership'
      )
    }
    return this.getLease(resourceType, resourceKey)
  }

  transitionSession(command) {
    return this.#executeTransition(command, null)
  }

  recordOperation(command, operation) {
    return this.#executeTransition(command, operation)
  }

  recordPreparedOperation(command, operation, intentId) {
    assertCanonicalSessionId(intentId)
    return this.#executeTransition(command, operation, intentId)
  }

  recordArtifact({
    id,
    sessionId,
    type,
    storageKey,
    sha256,
    sizeBytes,
    retentionClass,
    createdAt,
    pinned = false
  }) {
    assertCanonicalSessionId(id)
    assertCanonicalSessionId(sessionId)
    assertEnum(type, E3_ARTIFACT_TYPES, 'type')
    nullableText(storageKey, 'storageKey', 512)
    assertSha256(sha256)
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
      persistenceError(
        E3_PERSISTENCE_ERROR.INVALID_RECORD,
        'sizeBytes must be a non-negative integer'
      )
    }
    assertSafeToken(retentionClass, 'retentionClass')
    assertTimestamp(createdAt, 'createdAt')
    if (typeof pinned !== 'boolean') {
      persistenceError(
        E3_PERSISTENCE_ERROR.INVALID_RECORD,
        'pinned must be boolean'
      )
    }

    this.database.prepare(`
      INSERT INTO editor_artifacts (
        id,
        session_id,
        artifact_type,
        storage_key,
        sha256,
        size_bytes,
        retention_class,
        created_at,
        pinned
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      sessionId,
      type,
      storageKey,
      sha256,
      sizeBytes,
      retentionClass,
      createdAt,
      pinned ? 1 : 0
    )
    return freezeDomainValue({
      id,
      sessionId,
      type,
      storageKey,
      sha256,
      sizeBytes,
      retentionClass,
      createdAt,
      pinned
    })
  }

  createValidationRun({
    id,
    sessionId,
    profile,
    status,
    candidateSha256,
    timeoutMs,
    createdAt
  }) {
    assertCanonicalSessionId(id)
    assertCanonicalSessionId(sessionId)
    assertSafeToken(profile, 'profile')
    assertEnum(status, E3_VALIDATION_STATUSES, 'status')
    assertSha256(candidateSha256, 'candidateSha256')
    assertPositiveInteger(timeoutMs, 'timeoutMs')
    assertTimestamp(createdAt, 'createdAt')

    this.database.prepare(`
      INSERT INTO editor_validation_runs (
        id,
        session_id,
        profile,
        status,
        candidate_sha256,
        timeout_ms,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      sessionId,
      profile,
      status,
      candidateSha256,
      timeoutMs,
      createdAt
    )
    return freezeDomainValue({
      id,
      sessionId,
      profile,
      status,
      candidateSha256,
      timeoutMs,
      createdAt
    })
  }

  #insertSession(session) {
    this.database.prepare(`
      INSERT INTO editor_sessions (
        id,
        status,
        base_commit,
        request_summary,
        created_by,
        created_at,
        updated_at,
        review_ready_at,
        candidate_manifest_sha256,
        patch_sha256,
        validation_manifest_sha256,
        path_policy_version,
        profile_set_version,
        approved_by,
        approved_at,
        export_sha256,
        exported_at,
        failure_code,
        failure_message,
        failed_at,
        version
      ) VALUES (
        @id,
        @status,
        @baseCommit,
        @requestSummary,
        @createdBy,
        @createdAt,
        @updatedAt,
        @reviewReadyAt,
        @candidateManifestSha256,
        @patchSha256,
        @validationManifestSha256,
        @pathPolicyVersion,
        @profileSetVersion,
        @approvedBy,
        @approvedAt,
        @exportSha256,
        @exportedAt,
        @failureCode,
        @failureMessage,
        @failedAt,
        @version
      )
    `).run(this.#sessionParameters(session))
  }

  #sessionParameters(session) {
    return {
      id: session.id,
      status: session.status,
      baseCommit: session.baseCommit,
      requestSummary: session.requestSummary,
      createdBy: session.createdBy,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      reviewReadyAt: session.reviewReadyAt,
      candidateManifestSha256:
        session.candidate?.candidateManifestSha256 ?? null,
      patchSha256: session.candidate?.patchSha256 ?? null,
      validationManifestSha256:
        session.candidate?.validationManifestSha256 ?? null,
      pathPolicyVersion:
        session.candidate?.pathPolicyVersion ?? null,
      profileSetVersion:
        session.candidate?.profileSetVersion ?? null,
      approvedBy: session.approval?.approvedBy ?? null,
      approvedAt: session.approval?.approvedAt ?? null,
      exportSha256: session.exportArtifact?.sha256 ?? null,
      exportedAt: session.exportArtifact?.exportedAt ?? null,
      failureCode: session.failure?.code ?? null,
      failureMessage: session.failure?.message ?? null,
      failedAt: session.failure?.failedAt ?? null,
      version: session.version
    }
  }

  #insertEvent(event) {
    const result = this.database.prepare(`
      INSERT INTO editor_events (
        session_id,
        sequence,
        event_type,
        from_status,
        to_status,
        actor_id,
        request_id,
        version_before,
        version_after,
        metadata_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.sessionId,
      event.versionAfter,
      event.type,
      event.fromStatus,
      event.toStatus,
      event.actorId,
      event.requestId,
      event.versionBefore,
      event.versionAfter,
      canonicalJson(event.metadata),
      event.occurredAt
    )
    return Number(result.lastInsertRowid)
  }

  #executeTransition(command, operation, intentId = null) {
    assertPlainObject(command, 'command')
    assertCanonicalSessionId(command.sessionId)
    assertSafeToken(command.requestId, 'requestId', {
      minLength: 8,
      maxLength: 160
    })
    const checksum = requestChecksum(command, operation)

    const transaction = this.database.transaction(() => {
      const previousRequest = this.database.prepare(`
        SELECT command_sha256, result_json
        FROM editor_idempotency_keys
        WHERE session_id = ? AND request_id = ?
      `).get(command.sessionId, command.requestId)

      if (previousRequest) {
        if (previousRequest.command_sha256 !== checksum) {
          persistenceError(
            E3_PERSISTENCE_ERROR.IDEMPOTENCY_CONFLICT,
            'Request ID was already used for another command'
          )
        }
        const replay = freezeDomainValue({
          ...JSON.parse(previousRequest.result_json),
          replayed: true
        })
        if (intentId) {
          const intentUpdate = this.database.prepare(`
            UPDATE editor_operation_intents
            SET state = 'RECORDED', result_json = ?, recorded_at = ?
            WHERE id = ? AND session_id = ? AND request_id = ?
              AND state IN ('PUBLISHED', 'RECORDED')
          `).run(
            canonicalJson(replay),
            command.occurredAt,
            intentId,
            command.sessionId,
            command.requestId
          )
          if (intentUpdate.changes !== 1) {
            persistenceError(
              E3_PERSISTENCE_ERROR.INVALID_RECORD,
              'Prepared operation intent is not publishable'
            )
          }
        }
        return replay
      }

      const session = this.getSession(command.sessionId)
      if (!session) {
        persistenceError(
          E3_PERSISTENCE_ERROR.SESSION_NOT_FOUND,
          'Editor session does not exist',
          { sessionId: command.sessionId }
        )
      }
      const currentLease = this.getLease(
        E3_LEASE_RESOURCE_TYPE.SESSION,
        command.sessionId
      )
      if (!currentLease) {
        persistenceError(
          E3_PERSISTENCE_ERROR.LEASE_NOT_FOUND,
          'Editor session lease does not exist',
          { sessionId: command.sessionId }
        )
      }

      if (
        command.type === E3_SESSION_COMMAND.RECORD_MUTATION &&
        !operation
      ) {
        persistenceError(
          E3_PERSISTENCE_ERROR.OPERATION_REQUIRED,
          'Mutation transition requires an operation record'
        )
      }
      if (
        command.type !== E3_SESSION_COMMAND.RECORD_MUTATION &&
        operation
      ) {
        persistenceError(
          E3_PERSISTENCE_ERROR.INVALID_RECORD,
          'Operation record requires RECORD_MUTATION'
        )
      }

      const transition = transitionEditorSession(
        session,
        command,
        { currentLease }
      )
      const parameters = this.#sessionParameters(
        transition.session
      )
      const update = this.database.prepare(`
        UPDATE editor_sessions
        SET
          status = @status,
          updated_at = @updatedAt,
          review_ready_at = @reviewReadyAt,
          candidate_manifest_sha256 = @candidateManifestSha256,
          patch_sha256 = @patchSha256,
          validation_manifest_sha256 =
            @validationManifestSha256,
          path_policy_version = @pathPolicyVersion,
          profile_set_version = @profileSetVersion,
          approved_by = @approvedBy,
          approved_at = @approvedAt,
          export_sha256 = @exportSha256,
          exported_at = @exportedAt,
          failure_code = @failureCode,
          failure_message = @failureMessage,
          failed_at = @failedAt,
          version = @version
        WHERE id = @id AND version = @expectedVersion
      `).run({
        ...parameters,
        expectedVersion: session.version
      })
      if (update.changes !== 1) {
        persistenceError(
          E3_PERSISTENCE_ERROR.OPTIMISTIC_CONFLICT,
          'Session changed during transaction'
        )
      }
      this.faultInjector('transition.after_session_update')

      if (operation) {
        const record = validateOperation(operation, command)
        const nextSequence = this.database.prepare(`
          SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
          FROM editor_operations
          WHERE session_id = ?
        `).get(command.sessionId).sequence
        if (record.sequence !== nextSequence) {
          persistenceError(
            E3_PERSISTENCE_ERROR.INVALID_RECORD,
            'Operation sequence must be contiguous',
            {
              expectedSequence: nextSequence,
              actualSequence: record.sequence
            }
          )
        }
        this.database.prepare(`
          INSERT INTO editor_operations (
            id,
            session_id,
            sequence,
            operation_type,
            path_before,
            path_after,
            preimage_sha256,
            postimage_sha256,
            parameters_json,
            actor_id,
            request_id,
            created_at
          ) VALUES (
            @id,
            @sessionId,
            @sequence,
            @type,
            @pathBefore,
            @pathAfter,
            @preimageSha256,
            @postimageSha256,
            @parametersJson,
            @actorId,
            @requestId,
            @createdAt
          )
        `).run(record)
        this.faultInjector('transition.after_operation')
      }

      const eventId = this.#insertEvent(transition.event)
      this.faultInjector('transition.after_event')
      const result = freezeDomainValue({
        ...transition,
        event: {
          ...transition.event,
          id: eventId,
          sequence: transition.event.versionAfter
        }
      })
      this.database.prepare(`
        INSERT INTO editor_idempotency_keys (
          session_id,
          request_id,
          command_type,
          command_sha256,
          result_json,
          result_version,
          event_id,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        command.sessionId,
        command.requestId,
        command.type,
        checksum,
        canonicalJson(result),
        transition.session.version,
        eventId,
        command.occurredAt
      )
      if (intentId) {
        const intentUpdate = this.database.prepare(`
          UPDATE editor_operation_intents
          SET state = 'RECORDED', result_json = ?, recorded_at = ?
          WHERE id = ? AND session_id = ? AND request_id = ?
            AND state = 'PUBLISHED'
        `).run(
          canonicalJson(result),
          command.occurredAt,
          intentId,
          command.sessionId,
          command.requestId
        )
        if (intentUpdate.changes !== 1) {
          persistenceError(
            E3_PERSISTENCE_ERROR.INVALID_RECORD,
            'Prepared operation intent is not PUBLISHED'
          )
        }
      }
      return result
    })

    return transaction.immediate()
  }
}
