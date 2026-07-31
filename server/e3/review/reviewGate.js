import { randomUUID } from 'node:crypto'
import {
  E3_ARTIFACT_TYPE,
  E3_LEASE_RESOURCE_TYPE,
  E3_SESSION_COMMAND,
  E3_SESSION_STATUS,
  assertCanonicalSessionId,
  assertFencingToken,
  assertSafeToken,
  assertTimestamp,
  freezeDomainValue
} from '../core/contracts.js'
import { ArtifactStore } from '../artifacts/artifactStore.js'
import { EditorRepository } from '../persistence/editorRepository.js'
import {
  E3_REVIEW_POLICY,
  E3_REVIEW_POLICY_SHA256,
  E3_REVIEW_POLICY_VERSION,
  E3_REVIEW_REQUIRED_PROFILES,
  canonicalReviewJson,
  reviewGateFeatureEnabled,
  reviewSha256
} from './contracts.js'
import {
  E3_REVIEW_ERROR,
  E3ReviewError
} from './errors.js'

const CANDIDATE_ARTIFACTS = Object.freeze([
  ['candidate_manifest_artifact_id',
    'candidate_manifest_sha256',
    E3_ARTIFACT_TYPE.CANDIDATE_MANIFEST],
  ['forward_patch_artifact_id',
    'forward_patch_sha256',
    E3_ARTIFACT_TYPE.FORWARD_PATCH],
  ['reverse_patch_artifact_id',
    'reverse_patch_sha256',
    E3_ARTIFACT_TYPE.REVERSE_PATCH],
  ['unified_diff_artifact_id',
    'unified_diff_sha256',
    E3_ARTIFACT_TYPE.UNIFIED_DIFF],
  ['diff_stat_artifact_id',
    'diff_stat_sha256',
    E3_ARTIFACT_TYPE.DIFF_STAT]
])

function reviewError(code, message, details = {}, cause) {
  throw new E3ReviewError(
    code,
    message,
    details,
    cause ? { cause } : {}
  )
}

function rowToReview(row) {
  return row
    ? freezeDomainValue({
        id: row.id,
        sessionId: row.session_id,
        sessionVersion: row.session_version,
        candidateSetId: row.candidate_set_id,
        candidateManifestSha256:
          row.candidate_manifest_sha256,
        forwardPatchSha256: row.forward_patch_sha256,
        validationManifestArtifactId:
          row.validation_manifest_artifact_id,
        validationManifestSha256:
          row.validation_manifest_sha256,
        reviewSummaryArtifactId:
          row.review_summary_artifact_id,
        reviewSummarySha256: row.review_summary_sha256,
        pathPolicyVersion: row.path_policy_version,
        profileSetVersion: row.profile_set_version,
        profileSetSha256: row.profile_set_sha256,
        reviewPolicyVersion: row.review_policy_version,
        reviewPolicySha256: row.review_policy_sha256,
        validationEvidenceIds:
          JSON.parse(row.validation_evidence_json),
        requestSha256: row.request_sha256,
        actorId: row.actor_id,
        requestId: row.request_id,
        createdAt: row.created_at
      })
    : null
}

function assertEnvelope(input) {
  assertCanonicalSessionId(input.sessionId)
  assertCanonicalSessionId(input.candidateSetId)
  assertSafeToken(input.actorId, 'actorId')
  assertSafeToken(input.requestId, 'requestId', {
    minLength: 8,
    maxLength: 160
  })
  assertTimestamp(input.occurredAt, 'occurredAt')
  assertSafeToken(input.leaseOwner, 'leaseOwner')
  assertFencingToken(input.fencingToken)
  if (
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 0
  ) {
    reviewError(
      E3_REVIEW_ERROR.STALE_SESSION,
      'Expected session version is invalid'
    )
  }
  if (
    !Array.isArray(input.validationEvidenceIds) ||
    input.validationEvidenceIds.length !==
      E3_REVIEW_REQUIRED_PROFILES.length
  ) {
    reviewError(
      E3_REVIEW_ERROR.INCOMPLETE_EVIDENCE,
      'Review requires the complete validation evidence set'
    )
  }
  const unique = new Set(input.validationEvidenceIds)
  if (unique.size !== input.validationEvidenceIds.length) {
    reviewError(
      E3_REVIEW_ERROR.INVALID_EVIDENCE,
      'Validation evidence IDs must be unique'
    )
  }
  for (const id of unique) assertCanonicalSessionId(id)
}

export class ReviewGate {
  constructor(database, {
    artifactRoot,
    env = {},
    idFactory = randomUUID,
    faultInjector = () => {}
  }) {
    this.database = database
    this.store = new ArtifactStore(artifactRoot)
    this.sessions = new EditorRepository(database)
    this.enabled = reviewGateFeatureEnabled(env)
    this.idFactory = idFactory
    this.faultInjector = faultInjector
  }

  getForRequest(sessionId, requestId) {
    assertCanonicalSessionId(sessionId)
    assertSafeToken(requestId, 'requestId', {
      minLength: 8,
      maxLength: 160
    })
    return rowToReview(this.database.prepare(`
      SELECT * FROM editor_review_sets
      WHERE session_id = ? AND request_id = ?
    `).get(sessionId, requestId))
  }

  #verifyCandidate(candidateSet) {
    const bytes = {}
    try {
      for (const [idField, shaField, expectedType] of
        CANDIDATE_ARTIFACTS) {
        const artifact = this.database.prepare(`
          SELECT * FROM editor_artifacts WHERE id = ?
        `).get(candidateSet[idField])
        if (
          !artifact ||
          artifact.session_id !== candidateSet.session_id ||
          artifact.artifact_type !== expectedType ||
          artifact.sha256 !== candidateSet[shaField]
        ) {
          reviewError(
            E3_REVIEW_ERROR.HASH_BINDING_MISMATCH,
            'Candidate artifact metadata does not match its set',
            { artifactType: expectedType }
          )
        }
        bytes[expectedType] = this.store.read(artifact.sha256)
      }
    } catch (cause) {
      if (cause instanceof E3ReviewError) throw cause
      reviewError(
        E3_REVIEW_ERROR.ARTIFACT_TAMPERED,
        'Candidate artifact verification failed',
        {},
        cause
      )
    }
    let manifest
    try {
      manifest = JSON.parse(
        bytes[E3_ARTIFACT_TYPE.CANDIDATE_MANIFEST]
          .toString('utf8')
      )
    } catch (cause) {
      reviewError(
        E3_REVIEW_ERROR.ARTIFACT_TAMPERED,
        'Candidate manifest is not valid JSON',
        {},
        cause
      )
    }
    if (
      manifest.sessionId !== candidateSet.session_id ||
      manifest.baseCommit !== candidateSet.base_commit ||
      manifest.treeSha !== candidateSet.tree_sha ||
      manifest.pathPolicyVersion !==
        candidateSet.path_policy_version ||
      !Array.isArray(manifest.changedFiles) ||
      !Array.isArray(manifest.operations)
    ) {
      reviewError(
        E3_REVIEW_ERROR.HASH_BINDING_MISMATCH,
        'Candidate manifest identity does not match its metadata'
      )
    }
    return {
      manifest,
      diffStat:
        bytes[E3_ARTIFACT_TYPE.DIFF_STAT].toString('utf8')
    }
  }

  #loadEvidence(input, candidateSet) {
    const placeholders =
      input.validationEvidenceIds.map(() => '?').join(', ')
    const rows = this.database.prepare(`
      SELECT e.*, a.sha256 AS log_sha256,
        a.artifact_type AS log_artifact_type,
        a.session_id AS log_session_id
      FROM editor_validation_evidence e
      JOIN editor_artifacts a ON a.id = e.log_artifact_id
      WHERE e.id IN (${placeholders})
    `).all(...input.validationEvidenceIds)
    if (rows.length !== E3_REVIEW_REQUIRED_PROFILES.length) {
      reviewError(
        E3_REVIEW_ERROR.INCOMPLETE_EVIDENCE,
        'One or more validation evidence records are missing'
      )
    }
    const byProfile = new Map()
    let profileSetVersion
    let profileSetSha256
    for (const row of rows) {
      if (
        row.session_id !== input.sessionId ||
        row.candidate_set_id !== candidateSet.id ||
        row.candidate_manifest_sha256 !==
          candidateSet.candidate_manifest_sha256
      ) {
        reviewError(
          E3_REVIEW_ERROR.HASH_BINDING_MISMATCH,
          'Validation evidence belongs to another candidate'
        )
      }
      if (row.status !== 'SUCCEEDED') {
        reviewError(
          E3_REVIEW_ERROR.FAILED_VALIDATION,
          'Failed validation evidence cannot enter review',
          { profileId: row.profile_id, status: row.status }
        )
      }
      if (
        byProfile.has(row.profile_id) ||
        !E3_REVIEW_REQUIRED_PROFILES.includes(row.profile_id)
      ) {
        reviewError(
          E3_REVIEW_ERROR.INVALID_EVIDENCE,
          'Validation evidence profile selection is invalid'
        )
      }
      profileSetVersion ??= row.profile_set_version
      profileSetSha256 ??= row.profile_set_sha256
      if (
        row.profile_set_version !== profileSetVersion ||
        row.profile_set_sha256 !== profileSetSha256
      ) {
        reviewError(
          E3_REVIEW_ERROR.HASH_BINDING_MISMATCH,
          'Validation evidence mixes profile sets'
        )
      }
      if (
        row.log_artifact_type !==
          E3_ARTIFACT_TYPE.VALIDATION_LOG ||
        row.log_session_id !== input.sessionId
      ) {
        reviewError(
          E3_REVIEW_ERROR.HASH_BINDING_MISMATCH,
          'Validation log metadata is invalid'
        )
      }
      try {
        this.store.read(row.log_sha256)
      } catch (cause) {
        reviewError(
          E3_REVIEW_ERROR.ARTIFACT_TAMPERED,
          'Validation log verification failed',
          { profileId: row.profile_id },
          cause
        )
      }
      byProfile.set(row.profile_id, row)
    }
    const missing = E3_REVIEW_REQUIRED_PROFILES.filter(
      profileId => !byProfile.has(profileId)
    )
    if (missing.length > 0) {
      reviewError(
        E3_REVIEW_ERROR.INCOMPLETE_EVIDENCE,
        'Mandatory validation profiles are missing',
        { missing }
      )
    }
    return {
      profileSetVersion,
      profileSetSha256,
      rows: E3_REVIEW_REQUIRED_PROFILES.map(
        profileId => byProfile.get(profileId)
      )
    }
  }

  #verifyReviewArtifacts(review) {
    for (const [artifactId, expectedSha256, expectedType] of [
      [
        review.validationManifestArtifactId,
        review.validationManifestSha256,
        E3_ARTIFACT_TYPE.VALIDATION_MANIFEST
      ],
      [
        review.reviewSummaryArtifactId,
        review.reviewSummarySha256,
        E3_ARTIFACT_TYPE.REVIEW_SUMMARY
      ]
    ]) {
      const artifact = this.database.prepare(`
        SELECT * FROM editor_artifacts WHERE id = ?
      `).get(artifactId)
      if (
        !artifact ||
        artifact.session_id !== review.sessionId ||
        artifact.artifact_type !== expectedType ||
        artifact.sha256 !== expectedSha256
      ) {
        reviewError(
          E3_REVIEW_ERROR.HASH_BINDING_MISMATCH,
          'Review artifact metadata does not match its set'
        )
      }
      try {
        this.store.read(expectedSha256)
      } catch (cause) {
        reviewError(
          E3_REVIEW_ERROR.ARTIFACT_TAMPERED,
          'Review artifact verification failed',
          { artifactType: expectedType },
          cause
        )
      }
    }
  }

  markReady(input) {
    if (!this.enabled) {
      reviewError(
        E3_REVIEW_ERROR.FEATURE_DISABLED,
        'E3 review gate is disabled'
      )
    }
    assertEnvelope(input)
    const candidateSet = this.database.prepare(`
      SELECT * FROM editor_candidate_artifact_sets
      WHERE id = ? AND session_id = ?
    `).get(input.candidateSetId, input.sessionId)
    if (!candidateSet) {
      reviewError(
        E3_REVIEW_ERROR.HASH_BINDING_MISMATCH,
        'Review candidate set does not exist'
      )
    }
    const candidate = this.#verifyCandidate(candidateSet)
    const evidence = this.#loadEvidence(input, candidateSet)
    const canonicalEvidenceIds = evidence.rows.map(row => row.id)
    const requestSha256 = reviewSha256({
      version: 1,
      sessionId: input.sessionId,
      expectedVersion: input.expectedVersion,
      candidateSetId: input.candidateSetId,
      validationEvidenceIds: canonicalEvidenceIds,
      actorId: input.actorId,
      requestId: input.requestId,
      occurredAt: input.occurredAt,
      leaseOwner: input.leaseOwner,
      fencingToken: input.fencingToken
    })
    const existing = this.getForRequest(
      input.sessionId,
      input.requestId
    )
    if (existing) {
      if (existing.requestSha256 !== requestSha256) {
        reviewError(
          E3_REVIEW_ERROR.IDEMPOTENCY_CONFLICT,
          'Review request ID was reused for another request'
        )
      }
      this.#verifyReviewArtifacts(existing)
      return freezeDomainValue({
        review: existing,
        session: this.sessions.getSession(input.sessionId),
        replayed: true
      })
    }
    const session = this.sessions.getSession(input.sessionId)
    if (session?.status !== E3_SESSION_STATUS.VALIDATING) {
      reviewError(
        E3_REVIEW_ERROR.SESSION_NOT_VALIDATING,
        'Review gate requires a validating session'
      )
    }
    if (session.version !== input.expectedVersion) {
      reviewError(
        E3_REVIEW_ERROR.STALE_SESSION,
        'Review gate received a stale session version'
      )
    }
    const lease = this.sessions.getLease(
      E3_LEASE_RESOURCE_TYPE.SESSION,
      input.sessionId
    )
    if (
      !lease ||
      lease.owner !== input.leaseOwner ||
      lease.fencingToken !== input.fencingToken ||
      lease.expiresAt <= input.occurredAt
    ) {
      reviewError(
        E3_REVIEW_ERROR.LEASE_REQUIRED,
        'Review gate requires the current unexpired session lease'
      )
    }
    const validationManifestBytes = canonicalReviewJson({
      version: 1,
      sessionId: input.sessionId,
      baseCommit: candidateSet.base_commit,
      candidateSetId: candidateSet.id,
      candidateManifestSha256:
        candidateSet.candidate_manifest_sha256,
      profileSetVersion: evidence.profileSetVersion,
      profileSetSha256: evidence.profileSetSha256,
      reviewPolicy: E3_REVIEW_POLICY,
      reviewPolicySha256: E3_REVIEW_POLICY_SHA256,
      validations: evidence.rows.map(row => ({
        runId: row.id,
        profileId: row.profile_id,
        profileVersion: row.profile_version,
        profileSha256: row.profile_sha256,
        requestSha256: row.request_sha256,
        planSha256: row.plan_sha256,
        logSha256: row.log_sha256,
        status: row.status,
        exitCode: row.exit_code,
        signal: row.signal
      }))
    })
    const reviewSummaryBytes = canonicalReviewJson({
      version: 1,
      sessionId: input.sessionId,
      baseCommit: candidateSet.base_commit,
      requestSummary: session.requestSummary,
      candidateSetId: candidateSet.id,
      treeSha: candidateSet.tree_sha,
      changedFiles: candidate.manifest.changedFiles,
      operations: candidate.manifest.operations,
      diffStat: candidate.diffStat,
      artifacts: {
        candidateManifestSha256:
          candidateSet.candidate_manifest_sha256,
        forwardPatchSha256:
          candidateSet.forward_patch_sha256,
        reversePatchSha256:
          candidateSet.reverse_patch_sha256,
        unifiedDiffSha256:
          candidateSet.unified_diff_sha256,
        diffStatSha256: candidateSet.diff_stat_sha256
      },
      validationManifestSha256:
        reviewSha256(validationManifestBytes),
      reviewPolicyVersion: E3_REVIEW_POLICY_VERSION,
      reviewPolicySha256: E3_REVIEW_POLICY_SHA256
    })
    const validationArtifact = this.store.publish(
      validationManifestBytes
    )
    const summaryArtifact = this.store.publish(reviewSummaryBytes)
    const validationArtifactId = this.idFactory()
    const summaryArtifactId = this.idFactory()
    const reviewId = this.idFactory()
    for (const id of [
      validationArtifactId,
      summaryArtifactId,
      reviewId
    ]) {
      assertCanonicalSessionId(id)
    }

    try {
      return this.database.transaction(() => {
        const insertArtifact = this.database.prepare(`
          INSERT INTO editor_artifacts (
            id, session_id, artifact_type, storage_key, sha256,
            size_bytes, retention_class, created_at, pinned
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
        `)
        insertArtifact.run(
          validationArtifactId,
          input.sessionId,
          E3_ARTIFACT_TYPE.VALIDATION_MANIFEST,
          validationArtifact.storageKey,
          validationArtifact.sha256,
          validationArtifact.sizeBytes,
          'review-v1',
          input.occurredAt
        )
        insertArtifact.run(
          summaryArtifactId,
          input.sessionId,
          E3_ARTIFACT_TYPE.REVIEW_SUMMARY,
          summaryArtifact.storageKey,
          summaryArtifact.sha256,
          summaryArtifact.sizeBytes,
          'review-v1',
          input.occurredAt
        )
        this.faultInjector('review.after_artifacts')
        const transition = this.sessions.transitionSession({
          type: E3_SESSION_COMMAND.MARK_READY_FOR_REVIEW,
          sessionId: input.sessionId,
          expectedVersion: input.expectedVersion,
          actorId: input.actorId,
          requestId: input.requestId,
          occurredAt: input.occurredAt,
          leaseOwner: input.leaseOwner,
          fencingToken: input.fencingToken,
          candidate: {
            candidateManifestSha256:
              candidateSet.candidate_manifest_sha256,
            patchSha256: candidateSet.forward_patch_sha256,
            validationManifestSha256:
              validationArtifact.sha256,
            pathPolicyVersion:
              candidateSet.path_policy_version,
            profileSetVersion: evidence.profileSetVersion
          }
        })
        this.faultInjector('review.after_transition')
        this.database.prepare(`
          INSERT INTO editor_review_sets (
            id, session_id, session_version, candidate_set_id,
            candidate_manifest_sha256, forward_patch_sha256,
            validation_manifest_artifact_id,
            validation_manifest_sha256,
            review_summary_artifact_id, review_summary_sha256,
            path_policy_version, profile_set_version,
            profile_set_sha256, review_policy_version,
            review_policy_sha256, validation_evidence_json,
            request_sha256, actor_id, request_id, created_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          )
        `).run(
          reviewId,
          input.sessionId,
          transition.session.version,
          candidateSet.id,
          candidateSet.candidate_manifest_sha256,
          candidateSet.forward_patch_sha256,
          validationArtifactId,
          validationArtifact.sha256,
          summaryArtifactId,
          summaryArtifact.sha256,
          candidateSet.path_policy_version,
          evidence.profileSetVersion,
          evidence.profileSetSha256,
          E3_REVIEW_POLICY_VERSION,
          E3_REVIEW_POLICY_SHA256,
          JSON.stringify(canonicalEvidenceIds),
          requestSha256,
          input.actorId,
          input.requestId,
          input.occurredAt
        )
        this.faultInjector('review.after_record')
        return freezeDomainValue({
          ...transition,
          review: rowToReview(this.database.prepare(`
            SELECT * FROM editor_review_sets WHERE id = ?
          `).get(reviewId))
        })
      }).immediate()
    } catch (cause) {
      if (cause instanceof E3ReviewError) throw cause
      reviewError(
        E3_REVIEW_ERROR.PERSISTENCE_FAILED,
        'Review publication failed',
        {},
        cause
      )
    }
  }
}
