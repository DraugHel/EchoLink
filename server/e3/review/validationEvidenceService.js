import { randomUUID } from 'node:crypto'
import {
  E3_ARTIFACT_TYPE,
  E3_SESSION_STATUS,
  assertCanonicalSessionId,
  assertSafeToken,
  assertSha256,
  assertTimestamp,
  freezeDomainValue
} from '../core/contracts.js'
import { ArtifactStore } from '../artifacts/artifactStore.js'
import {
  E3_VALIDATION_LIMITS,
  E3_VALIDATION_PROFILE_IDS
} from '../validation/contracts.js'
import {
  canonicalReviewJson,
  reviewSha256
} from './contracts.js'
import {
  E3_REVIEW_ERROR,
  E3ReviewError
} from './errors.js'

const STATUS = Object.freeze({
  succeeded: 'SUCCEEDED',
  failed: 'FAILED',
  cancelled: 'CANCELLED',
  timed_out: 'TIMED_OUT'
})

function evidenceError(code, message, details = {}, cause) {
  throw new E3ReviewError(
    code,
    message,
    details,
    cause ? { cause } : {}
  )
}

function text(value, fieldName, maxBytes) {
  if (typeof value !== 'string' || value.includes('\0')) {
    evidenceError(
      E3_REVIEW_ERROR.INVALID_EVIDENCE,
      `${fieldName} is invalid`
    )
  }
  if (Buffer.byteLength(value) > maxBytes) {
    evidenceError(
      E3_REVIEW_ERROR.INVALID_EVIDENCE,
      `${fieldName} exceeds its byte limit`
    )
  }
  return value
}

function nullableSignal(value) {
  if (value === null || value === undefined) return null
  return assertSafeToken(value, 'signal', {
    minLength: 1,
    maxLength: 32
  })
}

function validateResult(result, {
  candidateSet,
  profileSetVersion
}) {
  if (!result || typeof result !== 'object') {
    evidenceError(
      E3_REVIEW_ERROR.INVALID_EVIDENCE,
      'Validation result is required'
    )
  }
  assertCanonicalSessionId(result.runId)
  assertCanonicalSessionId(result.sessionId)
  assertCanonicalSessionId(result.candidateSetId)
  assertSha256(
    result.candidateManifestSha256,
    'candidateManifestSha256'
  )
  if (!E3_VALIDATION_PROFILE_IDS.includes(result.profileId)) {
    evidenceError(
      E3_REVIEW_ERROR.INVALID_EVIDENCE,
      'Validation profile is not registered'
    )
  }
  if (
    !Number.isSafeInteger(result.profileVersion) ||
    result.profileVersion < 1
  ) {
    evidenceError(
      E3_REVIEW_ERROR.INVALID_EVIDENCE,
      'Validation profile version is invalid'
    )
  }
  assertSha256(result.profileSha256, 'profileSha256')
  assertSafeToken(
    result.profileSetVersion,
    'profileSetVersion'
  )
  assertSha256(
    result.profileSetSha256,
    'profileSetSha256'
  )
  assertSha256(result.requestSha256, 'requestSha256')
  assertSha256(result.planSha256, 'planSha256')
  if (
    result.sessionId !== candidateSet.session_id ||
    result.candidateSetId !== candidateSet.id ||
    result.candidateManifestSha256 !==
      candidateSet.candidate_manifest_sha256 ||
    result.profileSetVersion !== profileSetVersion
  ) {
    evidenceError(
      E3_REVIEW_ERROR.HASH_BINDING_MISMATCH,
      'Validation result does not match its candidate binding'
    )
  }
  const status = STATUS[result.status]
  if (!status) {
    evidenceError(
      E3_REVIEW_ERROR.INVALID_EVIDENCE,
      'Validation result status is invalid'
    )
  }
  if (
    result.exitCode !== null &&
    result.exitCode !== undefined &&
    !Number.isSafeInteger(result.exitCode)
  ) {
    evidenceError(
      E3_REVIEW_ERROR.INVALID_EVIDENCE,
      'Validation exit code is invalid'
    )
  }
  if (
    !Number.isSafeInteger(result.outputBytes) ||
    result.outputBytes < 0
  ) {
    evidenceError(
      E3_REVIEW_ERROR.INVALID_EVIDENCE,
      'Validation output byte count is invalid'
    )
  }
  return freezeDomainValue({
    id: result.runId,
    sessionId: result.sessionId,
    candidateSetId: result.candidateSetId,
    candidateManifestSha256:
      result.candidateManifestSha256,
    profileId: result.profileId,
    profileVersion: result.profileVersion,
    profileSha256: result.profileSha256,
    profileSetVersion: result.profileSetVersion,
    profileSetSha256: result.profileSetSha256,
    requestSha256: result.requestSha256,
    planSha256: result.planSha256,
    status,
    exitCode: result.exitCode ?? null,
    signal: nullableSignal(result.signal),
    stdout: text(
      result.stdout,
      'stdout',
      E3_VALIDATION_LIMITS.maxStdoutBytes
    ),
    stderr: text(
      result.stderr,
      'stderr',
      E3_VALIDATION_LIMITS.maxStderrBytes
    ),
    outputBytes: result.outputBytes
  })
}

function rowToEvidence(row) {
  return row
    ? freezeDomainValue({
        id: row.id,
        sessionId: row.session_id,
        candidateSetId: row.candidate_set_id,
        candidateManifestSha256:
          row.candidate_manifest_sha256,
        profileId: row.profile_id,
        profileVersion: row.profile_version,
        profileSha256: row.profile_sha256,
        profileSetVersion: row.profile_set_version,
        profileSetSha256: row.profile_set_sha256,
        requestSha256: row.request_sha256,
        planSha256: row.plan_sha256,
        status: row.status,
        exitCode: row.exit_code,
        signal: row.signal,
        outputBytes: row.output_bytes,
        logArtifactId: row.log_artifact_id,
        createdAt: row.created_at,
        finishedAt: row.finished_at
      })
    : null
}

export class ValidationEvidenceService {
  constructor(database, {
    artifactRoot,
    idFactory = randomUUID,
    faultInjector = () => {}
  }) {
    this.database = database
    this.store = new ArtifactStore(artifactRoot)
    this.idFactory = idFactory
    this.faultInjector = faultInjector
  }

  get(id) {
    assertCanonicalSessionId(id)
    return rowToEvidence(this.database.prepare(`
      SELECT * FROM editor_validation_evidence WHERE id = ?
    `).get(id))
  }

  record({
    result,
    profileSetVersion,
    createdAt,
    finishedAt
  }) {
    assertTimestamp(createdAt, 'createdAt')
    assertTimestamp(finishedAt, 'finishedAt')
    if (finishedAt < createdAt) {
      evidenceError(
        E3_REVIEW_ERROR.INVALID_EVIDENCE,
        'Validation finish precedes creation'
      )
    }
    const candidateSet = this.database.prepare(`
      SELECT * FROM editor_candidate_artifact_sets WHERE id = ?
    `).get(result?.candidateSetId)
    if (!candidateSet) {
      evidenceError(
        E3_REVIEW_ERROR.HASH_BINDING_MISMATCH,
        'Validation candidate set does not exist'
      )
    }
    const validated = validateResult(result, {
      candidateSet,
      profileSetVersion
    })
    const session = this.database.prepare(`
      SELECT status FROM editor_sessions WHERE id = ?
    `).get(validated.sessionId)
    if (session?.status !== E3_SESSION_STATUS.VALIDATING) {
      evidenceError(
        E3_REVIEW_ERROR.SESSION_NOT_VALIDATING,
        'Validation evidence requires a validating session'
      )
    }
    const logBytes = canonicalReviewJson({
      version: 1,
      runId: validated.id,
      profileId: validated.profileId,
      status: validated.status,
      exitCode: validated.exitCode,
      signal: validated.signal,
      stdout: validated.stdout,
      stderr: validated.stderr,
      outputBytes: validated.outputBytes
    })
    const published = this.store.publish(logBytes)
    const artifactId = this.idFactory()
    assertCanonicalSessionId(artifactId)
    const bindingSha256 = reviewSha256({
      ...validated,
      stdout: undefined,
      stderr: undefined,
      logSha256: published.sha256,
      createdAt,
      finishedAt
    })

    return this.database.transaction(() => {
      const existing = this.get(validated.id)
      if (existing) {
        const existingArtifact = this.database.prepare(`
          SELECT sha256 FROM editor_artifacts WHERE id = ?
        `).get(existing.logArtifactId)
        const existingBinding = reviewSha256({
          ...existing,
          logArtifactId: undefined,
          logSha256: existingArtifact?.sha256,
          stdout: undefined,
          stderr: undefined
        })
        if (existingBinding !== bindingSha256) {
          evidenceError(
            E3_REVIEW_ERROR.IDEMPOTENCY_CONFLICT,
            'Validation run ID was reused for different evidence'
          )
        }
        return existing
      }
      this.database.prepare(`
        INSERT INTO editor_artifacts (
          id, session_id, artifact_type, storage_key, sha256,
          size_bytes, retention_class, created_at, pinned
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
      `).run(
        artifactId,
        validated.sessionId,
        E3_ARTIFACT_TYPE.VALIDATION_LOG,
        published.storageKey,
        published.sha256,
        published.sizeBytes,
        'validation-v1',
        createdAt
      )
      this.faultInjector('evidence.after_artifact')
      this.database.prepare(`
        INSERT INTO editor_validation_evidence (
          id, session_id, candidate_set_id,
          candidate_manifest_sha256, profile_id, profile_version,
          profile_sha256, profile_set_version, profile_set_sha256,
          request_sha256, plan_sha256, status, exit_code, signal,
          output_bytes, log_artifact_id, created_at, finished_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `).run(
        validated.id,
        validated.sessionId,
        validated.candidateSetId,
        validated.candidateManifestSha256,
        validated.profileId,
        validated.profileVersion,
        validated.profileSha256,
        validated.profileSetVersion,
        validated.profileSetSha256,
        validated.requestSha256,
        validated.planSha256,
        validated.status,
        validated.exitCode,
        validated.signal,
        validated.outputBytes,
        artifactId,
        createdAt,
        finishedAt
      )
      this.faultInjector('evidence.after_record')
      return this.get(validated.id)
    }).immediate()
  }
}
