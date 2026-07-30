import {
  E3_ARTIFACT_TYPES,
  E3_SESSION_STATUS,
  assertCanonicalSessionId,
  assertFullGitCommit,
  assertSafeToken,
  assertSha256,
  assertTimestamp,
  freezeDomainValue
} from '../core/contracts.js'

function assertArtifact(artifact, sessionId) {
  assertCanonicalSessionId(artifact.id)
  if (artifact.sessionId !== sessionId) {
    throw new Error('Artifact belongs to another session')
  }
  if (!E3_ARTIFACT_TYPES.includes(artifact.type)) {
    throw new Error('Artifact type is not registered')
  }
  assertSafeToken(artifact.retentionClass, 'retentionClass')
  assertSha256(artifact.sha256)
  assertTimestamp(artifact.createdAt)
  if (
    typeof artifact.storageKey !== 'string' ||
    artifact.storageKey.length < 1 ||
    artifact.storageKey.length > 512 ||
    !Number.isSafeInteger(artifact.sizeBytes) ||
    artifact.sizeBytes < 0
  ) {
    throw new Error('Artifact metadata is invalid')
  }
}

export class CandidateArtifactRepository {
  constructor(database) {
    this.database = database
  }

  getForVersion(sessionId, sessionVersion) {
    assertCanonicalSessionId(sessionId)
    const row = this.database.prepare(`
      SELECT * FROM editor_candidate_artifact_sets
      WHERE session_id = ? AND session_version = ?
    `).get(sessionId, sessionVersion)
    return row ? freezeDomainValue({ ...row }) : null
  }

  recordSet({
    id,
    sessionId,
    sessionVersion,
    baseCommit,
    treeSha,
    pathPolicyVersion,
    createdAt,
    artifacts
  }) {
    assertCanonicalSessionId(id)
    assertCanonicalSessionId(sessionId)
    assertFullGitCommit(baseCommit)
    assertFullGitCommit(treeSha)
    assertSafeToken(pathPolicyVersion, 'pathPolicyVersion')
    assertTimestamp(createdAt)
    if (!Number.isSafeInteger(sessionVersion) || sessionVersion < 0) {
      throw new Error('Session version is invalid')
    }
    for (const artifact of Object.values(artifacts)) {
      assertArtifact(artifact, sessionId)
    }

    return this.database.transaction(() => {
      const existing = this.getForVersion(sessionId, sessionVersion)
      if (existing) return existing
      const session = this.database.prepare(`
        SELECT status, version, base_commit
        FROM editor_sessions WHERE id = ?
      `).get(sessionId)
      if (
        !session ||
        session.status !== E3_SESSION_STATUS.EDITING ||
        session.version !== sessionVersion ||
        session.base_commit !== baseCommit
      ) {
        throw new Error('Candidate set requires the current editing session')
      }
      const workspace = this.database.prepare(`
        SELECT state, base_commit FROM editor_workspaces WHERE session_id = ?
      `).get(sessionId)
      if (
        !workspace ||
        workspace.state !== 'READY' ||
        workspace.base_commit !== baseCommit
      ) {
        throw new Error('Candidate set requires the matching ready workspace')
      }
      const insertArtifact = this.database.prepare(`
        INSERT INTO editor_artifacts (
          id, session_id, artifact_type, storage_key, sha256,
          size_bytes, retention_class, created_at, pinned
        ) VALUES (
          @id, @sessionId, @type, @storageKey, @sha256,
          @sizeBytes, @retentionClass, @createdAt, 0
        )
      `)
      for (const artifact of Object.values(artifacts)) {
        insertArtifact.run(artifact)
      }
      this.database.prepare(`
        INSERT INTO editor_candidate_artifact_sets (
          id, session_id, session_version, base_commit, tree_sha,
          candidate_manifest_artifact_id, forward_patch_artifact_id,
          reverse_patch_artifact_id, unified_diff_artifact_id,
          diff_stat_artifact_id, candidate_manifest_sha256,
          forward_patch_sha256, reverse_patch_sha256,
          unified_diff_sha256, diff_stat_sha256,
          path_policy_version, created_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `).run(
        id,
        sessionId,
        sessionVersion,
        baseCommit,
        treeSha,
        artifacts.manifest.id,
        artifacts.forwardPatch.id,
        artifacts.reversePatch.id,
        artifacts.unifiedDiff.id,
        artifacts.diffStat.id,
        artifacts.manifest.sha256,
        artifacts.forwardPatch.sha256,
        artifacts.reversePatch.sha256,
        artifacts.unifiedDiff.sha256,
        artifacts.diffStat.sha256,
        pathPolicyVersion,
        createdAt
      )
      return this.getForVersion(sessionId, sessionVersion)
    }).immediate()
  }
}
