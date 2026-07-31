import {
  E3_LEASE_RESOURCE_TYPE,
  assertCanonicalSessionId,
  assertFencingToken,
  assertSafeToken,
  assertTimestamp,
  freezeDomainValue
} from '../core/contracts.js'
import {
  canonicalRecoveryJson
} from './contracts.js'
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

function rowToRun(row) {
  if (!row) return null
  return freezeDomainValue({
    id: row.id,
    policyVersion: row.policy_version,
    policySha256: row.policy_sha256,
    storageRootSha256: row.storage_root_sha256,
    requestSha256: row.request_sha256,
    actorId: row.actor_id,
    requestId: row.request_id,
    cleanupLeaseOwner: row.cleanup_lease_owner,
    cleanupFencingToken: row.cleanup_fencing_token,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    decisionCount: row.decision_count,
    cleanedCount: row.cleaned_count,
    finalizedCount: row.finalized_count,
    retainedCount: row.retained_count,
    quarantinedCount: row.quarantined_count,
    alreadyCleanCount: row.already_clean_count,
    reclaimedBytes: row.reclaimed_bytes,
    result: row.result
  })
}

function rowToDecision(row) {
  return freezeDomainValue({
    id: row.id,
    runId: row.run_id,
    resourceType: row.resource_type,
    resourceKeySha256: row.resource_key_sha256,
    sessionId: row.session_id,
    workspaceKey: row.workspace_key,
    initialState: row.initial_state,
    finalState: row.final_state,
    decision: row.decision,
    reasonCode: row.reason_code,
    manifestSha256: row.manifest_sha256,
    sessionFencingToken: row.session_fencing_token,
    workspaceFencingToken: row.workspace_fencing_token,
    logicalSizeBytes: row.logical_size_bytes,
    reclaimedBytes: row.reclaimed_bytes,
    details: JSON.parse(row.details_json),
    createdAt: row.created_at
  })
}

export class RecoveryRepository {
  constructor(database) {
    if (!database) {
      recoveryError(
        E3_RECOVERY_ERROR.INVALID_CONFIGURATION,
        'Recovery repository requires editor.db'
      )
    }
    this.database = database
  }

  getRunByRequestId(requestId) {
    assertSafeToken(requestId, 'requestId', {
      minLength: 8,
      maxLength: 160
    })
    const run = rowToRun(this.database.prepare(`
      SELECT *
      FROM editor_recovery_runs
      WHERE request_id = ?
    `).get(requestId))
    if (!run) return null
    const decisions = this.database.prepare(`
      SELECT *
      FROM editor_recovery_decisions
      WHERE run_id = ?
      ORDER BY id
    `).all(run.id).map(rowToDecision)
    return freezeDomainValue({ run, decisions })
  }

  getLease(resourceType, resourceKey) {
    return rowToLease(this.database.prepare(`
      SELECT *
      FROM editor_leases
      WHERE resource_type = ? AND resource_key = ?
    `).get(resourceType, resourceKey))
  }

  assertCleanupLease({
    owner,
    fencingToken,
    occurredAt
  }) {
    assertSafeToken(owner, 'cleanupLeaseOwner')
    assertFencingToken(fencingToken, 'cleanupFencingToken')
    assertTimestamp(occurredAt, 'occurredAt')
    const lease = this.getLease(
      E3_LEASE_RESOURCE_TYPE.CLEANUP,
      'global'
    )
    if (!lease) {
      recoveryError(
        E3_RECOVERY_ERROR.CLEANUP_LEASE_REQUIRED,
        'Global cleanup lease does not exist'
      )
    }
    if (
      lease.owner !== owner ||
      lease.fencingToken !== fencingToken
    ) {
      recoveryError(
        E3_RECOVERY_ERROR.CLEANUP_LEASE_MISMATCH,
        'Global cleanup lease ownership does not match'
      )
    }
    if (lease.expiresAt <= occurredAt) {
      recoveryError(
        E3_RECOVERY_ERROR.CLEANUP_LEASE_EXPIRED,
        'Global cleanup lease has expired'
      )
    }
    return lease
  }

  listWorkspaceSnapshots() {
    const rows = this.database.prepare(`
      SELECT
        w.*,
        s.status AS session_status,
        s.version AS session_version,
        s.updated_at AS session_updated_at
      FROM editor_workspaces w
      JOIN editor_sessions s ON s.id = w.session_id
      ORDER BY w.session_id
    `).all()

    return Object.freeze(rows.map(row => {
      const sessionLease = this.getLease(
        E3_LEASE_RESOURCE_TYPE.SESSION,
        row.session_id
      )
      const workspaceLease = this.getLease(
        E3_LEASE_RESOURCE_TYPE.WORKSPACE,
        row.session_id
      )
      const activeValidationCount = this.database.prepare(`
        SELECT COUNT(*) AS count
        FROM editor_validation_runs
        WHERE session_id = ? AND status IN ('QUEUED', 'RUNNING')
      `).get(row.session_id).count
      const openIntentCount = this.database.prepare(`
        SELECT COUNT(*) AS count
        FROM editor_operation_intents
        WHERE session_id = ?
          AND state IN ('PREPARED', 'PUBLISHED', 'RECOVERY_REQUIRED')
      `).get(row.session_id).count

      return freezeDomainValue({
        sessionId: row.session_id,
        sessionStatus: row.session_status,
        sessionVersion: row.session_version,
        sessionUpdatedAt: row.session_updated_at,
        workspaceKey: row.workspace_key,
        workspaceState: row.state,
        baseCommit: row.base_commit,
        treeSha: row.tree_sha,
        canonicalPath: row.canonical_path,
        manifestSha256: row.manifest_sha256,
        managerOwner: row.manager_owner,
        createdAt: row.created_at,
        heartbeatAt: row.heartbeat_at,
        fencingToken: row.fencing_token,
        logicalSizeBytes: row.logical_size_bytes,
        entryCount: row.entry_count,
        symlinkCount: row.symlink_count,
        removedAt: row.removed_at,
        sessionLease,
        workspaceLease,
        activeValidationCount,
        openIntentCount
      })
    }))
  }

  claimExpiredLease({
    resourceType,
    sessionId,
    owner,
    occurredAt,
    expiresAt,
    expectedLease
  }) {
    assertCanonicalSessionId(sessionId)
    if (![
      E3_LEASE_RESOURCE_TYPE.SESSION,
      E3_LEASE_RESOURCE_TYPE.WORKSPACE
    ].includes(resourceType)) {
      recoveryError(
        E3_RECOVERY_ERROR.INVALID_REQUEST,
        'Recovery may take over only session or workspace leases'
      )
    }
    assertSafeToken(owner, 'leaseOwner')
    assertTimestamp(occurredAt, 'occurredAt')
    assertTimestamp(expiresAt, 'expiresAt')
    if (expiresAt <= occurredAt) {
      recoveryError(
        E3_RECOVERY_ERROR.INVALID_REQUEST,
        'Recovery lease expiry must be in the future'
      )
    }

    const transaction = this.database.transaction(() => {
      const current = this.getLease(resourceType, sessionId)
      if (!current) {
        if (expectedLease) {
          recoveryError(
            E3_RECOVERY_ERROR.LEASE_TAKEOVER_BLOCKED,
            'Lease disappeared before recovery takeover'
          )
        }
        this.database.prepare(`
          INSERT INTO editor_leases (
            resource_type, resource_key, owner,
            acquired_at, heartbeat_at, expires_at, fencing_token
          ) VALUES (?, ?, ?, ?, ?, ?, 1)
        `).run(
          resourceType,
          sessionId,
          owner,
          occurredAt,
          occurredAt,
          expiresAt
        )
        return this.getLease(resourceType, sessionId)
      }

      if (
        !expectedLease ||
        current.owner !== expectedLease.owner ||
        current.fencingToken !== expectedLease.fencingToken ||
        current.expiresAt !== expectedLease.expiresAt ||
        current.expiresAt > occurredAt
      ) {
        recoveryError(
          E3_RECOVERY_ERROR.LEASE_TAKEOVER_BLOCKED,
          'Lease is live or changed before recovery takeover'
        )
      }

      const nextToken = current.fencingToken + 1
      if (!Number.isSafeInteger(nextToken)) {
        recoveryError(
          E3_RECOVERY_ERROR.LEASE_TAKEOVER_BLOCKED,
          'Lease fencing token cannot be advanced safely'
        )
      }
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
          AND owner = ?
          AND fencing_token = ?
          AND expires_at = ?
          AND expires_at <= ?
      `).run(
        owner,
        occurredAt,
        occurredAt,
        expiresAt,
        nextToken,
        resourceType,
        sessionId,
        current.owner,
        current.fencingToken,
        current.expiresAt,
        occurredAt
      )
      if (update.changes !== 1) {
        recoveryError(
          E3_RECOVERY_ERROR.LEASE_TAKEOVER_BLOCKED,
          'Lease changed during recovery takeover'
        )
      }
      return this.getLease(resourceType, sessionId)
    })

    return transaction.immediate()
  }

  recordRun(run, decisions) {
    const transaction = this.database.transaction(() => {
      const existing = this.getRunByRequestId(run.requestId)
      if (existing) {
        if (existing.run.requestSha256 !== run.requestSha256) {
          recoveryError(
            E3_RECOVERY_ERROR.REQUEST_REPLAY_CONFLICT,
            'Recovery request ID was reused with different bytes'
          )
        }
        return freezeDomainValue({
          ...existing,
          replayed: true
        })
      }

      this.database.prepare(`
        INSERT INTO editor_recovery_runs (
          id, policy_version, policy_sha256, storage_root_sha256,
          request_sha256, actor_id, request_id,
          cleanup_lease_owner, cleanup_fencing_token,
          started_at, completed_at, decision_count,
          cleaned_count, finalized_count, retained_count,
          quarantined_count, already_clean_count, reclaimed_bytes, result
        ) VALUES (
          @id, @policyVersion, @policySha256, @storageRootSha256,
          @requestSha256, @actorId, @requestId,
          @cleanupLeaseOwner, @cleanupFencingToken,
          @startedAt, @completedAt, @decisionCount,
          @cleanedCount, @finalizedCount, @retainedCount,
          @quarantinedCount, @alreadyCleanCount, @reclaimedBytes, 'SUCCEEDED'
        )
      `).run(run)

      const insertDecision = this.database.prepare(`
        INSERT INTO editor_recovery_decisions (
          id, run_id, resource_type, resource_key_sha256,
          session_id, workspace_key, initial_state, final_state,
          decision, reason_code, manifest_sha256,
          session_fencing_token, workspace_fencing_token,
          logical_size_bytes, reclaimed_bytes, details_json, created_at
        ) VALUES (
          @id, @runId, @resourceType, @resourceKeySha256,
          @sessionId, @workspaceKey, @initialState, @finalState,
          @decision, @reasonCode, @manifestSha256,
          @sessionFencingToken, @workspaceFencingToken,
          @logicalSizeBytes, @reclaimedBytes, @detailsJson, @createdAt
        )
      `)

      for (const decision of decisions) {
        insertDecision.run({
          id: decision.id,
          runId: decision.runId,
          resourceType: decision.resourceType,
          resourceKeySha256: decision.resourceKeySha256,
          sessionId: decision.sessionId,
          workspaceKey: decision.workspaceKey,
          initialState: decision.initialState,
          finalState: decision.finalState,
          decision: decision.decision,
          reasonCode: decision.reasonCode,
          manifestSha256: decision.manifestSha256,
          sessionFencingToken: decision.sessionFencingToken,
          workspaceFencingToken: decision.workspaceFencingToken,
          logicalSizeBytes: decision.logicalSizeBytes,
          reclaimedBytes: decision.reclaimedBytes,
          detailsJson: canonicalRecoveryJson(decision.details),
          createdAt: decision.createdAt
        })
      }

      return freezeDomainValue({
        run: freezeDomainValue({ ...run, result: 'SUCCEEDED' }),
        decisions: Object.freeze(decisions.map(freezeDomainValue)),
        replayed: false
      })
    })

    try {
      return transaction.immediate()
    } catch (cause) {
      if (cause instanceof E3RecoveryError) throw cause
      recoveryError(
        E3_RECOVERY_ERROR.PERSISTENCE_FAILED,
        'Recovery audit transaction failed',
        {},
        cause
      )
    }
  }
}
