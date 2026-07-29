import {
  E3_LEASE_RESOURCE_TYPE,
  E3_SESSION_STATUS,
  assertCanonicalSessionId,
  assertFencingToken,
  assertFullGitCommit,
  assertSafeToken,
  assertSha256,
  assertTimestamp,
  freezeDomainValue
} from '../core/contracts.js'
import {
  E3_WORKSPACE_STATE
} from './contracts.js'
import {
  E3_WORKSPACE_ERROR,
  E3WorkspaceError
} from './errors.js'

const CLEANUP_SESSION_STATUSES = Object.freeze([
  E3_SESSION_STATUS.COMPLETED,
  E3_SESSION_STATUS.FAILED,
  E3_SESSION_STATUS.CANCELLED,
  E3_SESSION_STATUS.STALE,
  E3_SESSION_STATUS.CONFLICTED,
  E3_SESSION_STATUS.REVERTED
])

function workspaceError(code, message, details = {}) {
  throw new E3WorkspaceError(code, message, details)
}

function assertCounter(value, fieldName) {
  if (!Number.isSafeInteger(value) || value < 0) {
    workspaceError(
      E3_WORKSPACE_ERROR.WORKSPACE_RECORD_MISMATCH,
      `${fieldName} must be a non-negative integer`
    )
  }
}

function rowToWorkspace(row) {
  if (!row) return null
  return freezeDomainValue({
    sessionId: row.session_id,
    workspaceKey: row.workspace_key,
    state: row.state,
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
    removedAt: row.removed_at
  })
}

export class WorkspaceRepository {
  constructor(database) {
    this.database = database
  }

  getSession(sessionId) {
    assertCanonicalSessionId(sessionId)
    return this.database.prepare(`
      SELECT id, status, base_commit, version
      FROM editor_sessions
      WHERE id = ?
    `).get(sessionId) ?? null
  }

  getWorkspace(sessionId) {
    assertCanonicalSessionId(sessionId)
    return rowToWorkspace(this.database.prepare(`
      SELECT *
      FROM editor_workspaces
      WHERE session_id = ?
    `).get(sessionId))
  }

  getCurrentWorkspaceLease(sessionId) {
    assertCanonicalSessionId(sessionId)
    return this.database.prepare(`
      SELECT owner, fencing_token
      FROM editor_leases
      WHERE resource_type = ? AND resource_key = ?
    `).get(
      E3_LEASE_RESOURCE_TYPE.WORKSPACE,
      sessionId
    ) ?? null
  }

  assertCurrentWorkspaceLease(
    sessionId,
    managerOwner,
    fencingToken
  ) {
    assertCanonicalSessionId(sessionId)
    assertSafeToken(managerOwner, 'managerOwner')
    assertFencingToken(fencingToken)
    const lease = this.getCurrentWorkspaceLease(sessionId)
    if (
      !lease ||
      lease.owner !== managerOwner ||
      lease.fencing_token !== fencingToken
    ) {
      workspaceError(
        E3_WORKSPACE_ERROR.LEASE_MISMATCH,
        'Workspace lease does not match current DB ownership'
      )
    }
  }

  registerWorkspace(record) {
    assertCanonicalSessionId(record.sessionId)
    assertSafeToken(record.workspaceKey, 'workspaceKey')
    assertFullGitCommit(record.baseCommit)
    assertFullGitCommit(record.treeSha)
    assertSha256(record.manifestSha256, 'manifestSha256')
    assertSafeToken(record.managerOwner, 'managerOwner')
    assertTimestamp(record.createdAt, 'createdAt')
    assertTimestamp(record.heartbeatAt, 'heartbeatAt')
    assertFencingToken(record.fencingToken)
    assertCounter(record.logicalSizeBytes, 'logicalSizeBytes')
    assertCounter(record.entryCount, 'entryCount')
    assertCounter(record.symlinkCount, 'symlinkCount')

    if (
      typeof record.canonicalPath !== 'string' ||
      !record.canonicalPath.startsWith('/')
    ) {
      workspaceError(
        E3_WORKSPACE_ERROR.WORKSPACE_RECORD_MISMATCH,
        'Workspace path must be canonical and absolute'
      )
    }

    const transaction = this.database.transaction(() => {
      const session = this.getSession(record.sessionId)
      if (
        !session ||
        session.status !== E3_SESSION_STATUS.PROVISIONING ||
        session.base_commit !== record.baseCommit
      ) {
        workspaceError(
          E3_WORKSPACE_ERROR.INVALID_SESSION_STATE,
          'Workspace requires its matching provisioning session'
        )
      }
      this.assertCurrentWorkspaceLease(
        record.sessionId,
        record.managerOwner,
        record.fencingToken
      )
      if (this.getWorkspace(record.sessionId)) {
        workspaceError(
          E3_WORKSPACE_ERROR.WORKSPACE_EXISTS,
          'Session already has workspace metadata'
        )
      }

      this.database.prepare(`
        INSERT INTO editor_workspaces (
          session_id,
          workspace_key,
          state,
          base_commit,
          tree_sha,
          canonical_path,
          manifest_sha256,
          manager_owner,
          created_at,
          heartbeat_at,
          fencing_token,
          logical_size_bytes,
          entry_count,
          symlink_count
        ) VALUES (
          @sessionId,
          @workspaceKey,
          @state,
          @baseCommit,
          @treeSha,
          @canonicalPath,
          @manifestSha256,
          @managerOwner,
          @createdAt,
          @heartbeatAt,
          @fencingToken,
          @logicalSizeBytes,
          @entryCount,
          @symlinkCount
        )
      `).run({
        ...record,
        state: E3_WORKSPACE_STATE.READY
      })
      return this.getWorkspace(record.sessionId)
    })

    return transaction.immediate()
  }

  beginRemoval({
    sessionId,
    managerOwner,
    fencingToken,
    occurredAt
  }) {
    assertTimestamp(occurredAt, 'occurredAt')
    const transaction = this.database.transaction(() => {
      const workspace = this.getWorkspace(sessionId)
      if (!workspace) {
        workspaceError(
          E3_WORKSPACE_ERROR.WORKSPACE_NOT_FOUND,
          'Workspace metadata does not exist'
        )
      }
      this.assertCurrentWorkspaceLease(
        sessionId,
        managerOwner,
        fencingToken
      )
      const session = this.getSession(sessionId)
      if (
        !session ||
        !CLEANUP_SESSION_STATUSES.includes(session.status)
      ) {
        workspaceError(
          E3_WORKSPACE_ERROR.CLEANUP_BLOCKED,
          'Active session workspace cannot be removed'
        )
      }
      if (workspace.state === E3_WORKSPACE_STATE.REMOVED) {
        return workspace
      }
      if (
        workspace.state !== E3_WORKSPACE_STATE.READY &&
        workspace.state !== E3_WORKSPACE_STATE.REMOVING
      ) {
        workspaceError(
          E3_WORKSPACE_ERROR.CLEANUP_BLOCKED,
          'Workspace state is not removable'
        )
      }
      if (workspace.state === E3_WORKSPACE_STATE.READY) {
        const update = this.database.prepare(`
          UPDATE editor_workspaces
          SET state = ?, heartbeat_at = ?
          WHERE
            session_id = ?
            AND state = ?
            AND fencing_token = ?
        `).run(
          E3_WORKSPACE_STATE.REMOVING,
          occurredAt,
          sessionId,
          E3_WORKSPACE_STATE.READY,
          fencingToken
        )
        if (update.changes !== 1) {
          workspaceError(
            E3_WORKSPACE_ERROR.LEASE_MISMATCH,
            'Workspace changed before removal'
          )
        }
      }
      return this.getWorkspace(sessionId)
    })

    return transaction.immediate()
  }

  completeRemoval({
    sessionId,
    managerOwner,
    fencingToken,
    removedAt
  }) {
    assertTimestamp(removedAt, 'removedAt')
    const transaction = this.database.transaction(() => {
      const workspace = this.getWorkspace(sessionId)
      if (!workspace) {
        workspaceError(
          E3_WORKSPACE_ERROR.WORKSPACE_NOT_FOUND,
          'Workspace metadata does not exist'
        )
      }
      if (workspace.state === E3_WORKSPACE_STATE.REMOVED) {
        return workspace
      }
      this.assertCurrentWorkspaceLease(
        sessionId,
        managerOwner,
        fencingToken
      )
      if (workspace.state !== E3_WORKSPACE_STATE.REMOVING) {
        workspaceError(
          E3_WORKSPACE_ERROR.CLEANUP_BLOCKED,
          'Workspace removal was not durably started'
        )
      }
      const update = this.database.prepare(`
        UPDATE editor_workspaces
        SET
          state = ?,
          heartbeat_at = ?,
          logical_size_bytes = 0,
          entry_count = 0,
          symlink_count = 0,
          removed_at = ?
        WHERE
          session_id = ?
          AND state = ?
          AND fencing_token = ?
      `).run(
        E3_WORKSPACE_STATE.REMOVED,
        removedAt,
        removedAt,
        sessionId,
        E3_WORKSPACE_STATE.REMOVING,
        fencingToken
      )
      if (update.changes !== 1) {
        workspaceError(
          E3_WORKSPACE_ERROR.LEASE_MISMATCH,
          'Workspace changed before removal completion'
        )
      }
      return this.getWorkspace(sessionId)
    })

    return transaction.immediate()
  }
}
