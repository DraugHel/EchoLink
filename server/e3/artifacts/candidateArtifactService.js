import { randomUUID } from 'node:crypto'
import {
  E3_ARTIFACT_TYPE
} from '../core/contracts.js'
import { E3_PATH_POLICY_VERSION } from '../editor/contracts.js'
import { sha256 } from '../editor/safeTextFilesystem.js'
import {
  OperationIntentRepository
} from '../editor/operationIntentRepository.js'
import { ArtifactStore } from './artifactStore.js'
import { CandidateBuilder } from './candidateBuilder.js'
import {
  CandidateArtifactRepository
} from './candidateArtifactRepository.js'

const DEFINITIONS = Object.freeze({
  manifest: E3_ARTIFACT_TYPE.CANDIDATE_MANIFEST,
  forwardPatch: E3_ARTIFACT_TYPE.FORWARD_PATCH,
  reversePatch: E3_ARTIFACT_TYPE.REVERSE_PATCH,
  unifiedDiff: E3_ARTIFACT_TYPE.UNIFIED_DIFF,
  diffStat: E3_ARTIFACT_TYPE.DIFF_STAT
})

function sameCandidate(left, right) {
  return (
    left.treeSha === right.treeSha &&
    Object.keys(DEFINITIONS).every(key =>
      sha256(left[key]) === sha256(right[key])
    )
  )
}

export class CandidateArtifactService {
  constructor(database, {
    artifactRoot,
    idFactory = randomUUID,
    builder = new CandidateBuilder(),
    faultInjector = () => {}
  }) {
    this.database = database
    this.store = new ArtifactStore(artifactRoot)
    this.repository = new CandidateArtifactRepository(database)
    this.intents = new OperationIntentRepository(database)
    this.idFactory = idFactory
    this.builder = builder
    this.faultInjector = faultInjector
  }

  create({
    sessionId,
    expectedVersion,
    occurredAt,
    sessionOwner,
    sessionFencingToken,
    workspaceOwner,
    workspaceFencingToken
  }) {
    const existing = this.repository.getForVersion(
      sessionId,
      expectedVersion
    )
    if (existing) return existing
    const activeIntent = this.database.prepare(`
      SELECT id FROM editor_operation_intents
      WHERE session_id = ?
        AND state IN ('PREPARED', 'PUBLISHED', 'RECOVERY_REQUIRED')
      LIMIT 1
    `).get(sessionId)
    if (activeIntent) {
      throw new Error('Candidate cannot freeze with an active operation intent')
    }
    const workspace = this.intents.assertCurrentOwnership({
      sessionId,
      sessionOwner,
      sessionFencingToken,
      workspaceOwner,
      workspaceFencingToken,
      occurredAt
    })
    const session = this.database.prepare(`
      SELECT status, version, base_commit, updated_at
      FROM editor_sessions WHERE id = ?
    `).get(sessionId)
    if (
      !session ||
      session.status !== 'EDITING' ||
      session.version !== expectedVersion
    ) {
      throw new Error('Candidate requires the expected editing session')
    }
    const operations = this.database.prepare(`
      SELECT
        sequence,
        operation_type AS type,
        path_before AS pathBefore,
        path_after AS pathAfter,
        preimage_sha256 AS preimageSha256,
        postimage_sha256 AS postimageSha256
      FROM editor_operations
      WHERE session_id = ?
      ORDER BY sequence
    `).all(sessionId)
    if (operations.length === 0) {
      throw new Error('Candidate requires at least one recorded operation')
    }
    const input = {
      sessionId,
      baseCommit: session.base_commit,
      workspacePath: workspace.canonical_path,
      sessionVersion: session.version,
      operations,
      generatedAt: session.updated_at
    }
    const candidate = this.builder.build(input)
    this.faultInjector('after_first_build', { candidate })
    this.intents.assertCurrentOwnership({
      sessionId,
      sessionOwner,
      sessionFencingToken,
      workspaceOwner,
      workspaceFencingToken,
      occurredAt
    })
    const verification = this.builder.build(input)
    if (!sameCandidate(candidate, verification)) {
      throw new Error('Workspace changed while candidate was frozen')
    }

    const artifacts = {}
    for (const [key, type] of Object.entries(DEFINITIONS)) {
      const published = this.store.publish(candidate[key])
      artifacts[key] = {
        id: this.idFactory(),
        sessionId,
        type,
        ...published,
        retentionClass: 'candidate-v1',
        createdAt: occurredAt
      }
    }
    this.store.publishSessionManifest(
      sessionId,
      artifacts.manifest.sha256
    )
    this.faultInjector('after_artifact_publish', { artifacts })
    return this.repository.recordSet({
      id: this.idFactory(),
      sessionId,
      sessionVersion: expectedVersion,
      baseCommit: session.base_commit,
      treeSha: candidate.treeSha,
      pathPolicyVersion: E3_PATH_POLICY_VERSION,
      createdAt: occurredAt,
      artifacts
    })
  }
}
