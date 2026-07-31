import { randomUUID } from 'node:crypto'
import {
  E3_ARTIFACT_TYPE,
  E3_LEASE_RESOURCE_TYPE,
  E3_SESSION_COMMAND,
  E3_SESSION_STATUS,
  assertCanonicalSessionId,
  assertFencingToken,
  assertFullGitCommit,
  assertSafeToken,
  assertSha256,
  assertTimestamp,
  freezeDomainValue
} from '../core/contracts.js'
import { ArtifactStore } from '../artifacts/artifactStore.js'
import { EditorRepository } from '../persistence/editorRepository.js'
import { canonicalReviewJson } from '../review/contracts.js'
import {
  E3_APPROVAL_DECISION,
  E3_APPROVAL_POLICY_SHA256,
  E3_APPROVAL_POLICY_VERSION,
  E3_APPROVAL_STATEMENT_FIELDS,
  approvalGateFeatureEnabled,
  approvalSha256,
  canonicalApprovalJson
} from './contracts.js'
import {
  E3_APPROVAL_ERROR,
  E3ApprovalError
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

const APPROVAL_REQUEST_FIELDS = Object.freeze([
  'sessionId',
  'expectedVersion',
  'reviewSetId',
  'actorId',
  'requestId',
  'occurredAt',
  'leaseOwner',
  'fencingToken',
  'statement'
])

function approvalError(code, message, details = {}, cause) {
  throw new E3ApprovalError(
    code,
    message,
    details,
    cause ? { cause } : {}
  )
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch (cause) {
    approvalError(
      E3_APPROVAL_ERROR.ARTIFACT_TAMPERED,
      `${label} is not valid JSON`,
      {},
      cause
    )
  }
}

function assertCanonicalJson(bytes, value, label) {
  if (!bytes.equals(Buffer.from(canonicalReviewJson(value), 'utf8'))) {
    approvalError(
      E3_APPROVAL_ERROR.ARTIFACT_TAMPERED,
      `${label} is not canonical review JSON`
    )
  }
}

function rowToApproval(row) {
  if (!row) return null
  let statement
  try {
    statement = JSON.parse(row.statement_json)
  } catch (cause) {
    approvalError(
      E3_APPROVAL_ERROR.ARTIFACT_TAMPERED,
      'Persisted approval statement is invalid JSON',
      {},
      cause
    )
  }
  return freezeDomainValue({
    id: row.id,
    sessionId: row.session_id,
    reviewSessionVersion: row.review_session_version,
    approvedSessionVersion: row.approved_session_version,
    reviewSetId: row.review_set_id,
    candidateSetId: row.candidate_set_id,
    baseCommit: row.base_commit,
    candidateManifestSha256:
      row.candidate_manifest_sha256,
    forwardPatchSha256: row.forward_patch_sha256,
    validationManifestSha256:
      row.validation_manifest_sha256,
    reviewSummarySha256: row.review_summary_sha256,
    pathPolicyVersion: row.path_policy_version,
    profileSetVersion: row.profile_set_version,
    profileSetSha256: row.profile_set_sha256,
    reviewPolicyVersion: row.review_policy_version,
    reviewPolicySha256: row.review_policy_sha256,
    approvalPolicyVersion: row.approval_policy_version,
    approvalPolicySha256: row.approval_policy_sha256,
    decision: row.decision,
    statement,
    statementSha256: row.statement_sha256,
    requestSha256: row.request_sha256,
    actorId: row.actor_id,
    requestId: row.request_id,
    createdAt: row.created_at
  })
}

function assertExactFields(value, fields, {
  code = E3_APPROVAL_ERROR.INVALID_STATEMENT,
  label = 'Approval statement'
} = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    approvalError(code, `${label} must be an object`)
  }
  const actual = Object.keys(value).sort()
  const expected = [...fields].sort()
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    approvalError(
      code,
      `${label} fields do not match the V1 contract`
    )
  }
}

function assertEnvelope(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    approvalError(
      E3_APPROVAL_ERROR.INVALID_REQUEST,
      'Approval request must be an object'
    )
  }
  assertExactFields(input, APPROVAL_REQUEST_FIELDS, {
    code: E3_APPROVAL_ERROR.INVALID_REQUEST,
    label: 'Approval request'
  })
  try {
    assertCanonicalSessionId(input.sessionId)
    assertCanonicalSessionId(input.reviewSetId)
    assertSafeToken(input.actorId, 'actorId')
    assertSafeToken(input.requestId, 'requestId', {
      minLength: 8,
      maxLength: 160
    })
    assertTimestamp(input.occurredAt, 'occurredAt')
    assertSafeToken(input.leaseOwner, 'leaseOwner')
    assertFencingToken(input.fencingToken)
  } catch (cause) {
    if (cause instanceof E3ApprovalError) throw cause
    approvalError(
      E3_APPROVAL_ERROR.INVALID_REQUEST,
      'Approval request envelope is invalid',
      {},
      cause
    )
  }
  if (
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 0
  ) {
    approvalError(
      E3_APPROVAL_ERROR.STALE_SESSION,
      'Expected session version is invalid'
    )
  }
  assertExactFields(input.statement, E3_APPROVAL_STATEMENT_FIELDS)
}

function assertStatementPrimitives(statement) {
  if (
    statement.version !== 1 ||
    statement.decision !== E3_APPROVAL_DECISION.APPROVE
  ) {
    approvalError(
      E3_APPROVAL_ERROR.INVALID_STATEMENT,
      'Approval statement version or decision is invalid'
    )
  }
  try {
    assertCanonicalSessionId(statement.sessionId)
    assertFullGitCommit(statement.baseCommit)
    if (
      !Number.isSafeInteger(statement.sessionVersion) ||
      statement.sessionVersion < 1
    ) {
      approvalError(
        E3_APPROVAL_ERROR.INVALID_STATEMENT,
        'Approval statement session version is invalid'
      )
    }
    assertCanonicalSessionId(statement.reviewSetId)
    assertCanonicalSessionId(statement.candidateSetId)
    for (const field of [
      'candidateManifestSha256',
      'forwardPatchSha256',
      'validationManifestSha256',
      'reviewSummarySha256',
      'profileSetSha256',
      'reviewPolicySha256',
      'approvalPolicySha256'
    ]) {
      assertSha256(statement[field], field)
    }
    for (const field of [
      'pathPolicyVersion',
      'profileSetVersion',
      'reviewPolicyVersion',
      'approvalPolicyVersion',
      'actorId'
    ]) {
      assertSafeToken(statement[field], field)
    }
    assertTimestamp(statement.occurredAt, 'statement.occurredAt')
  } catch (cause) {
    if (cause instanceof E3ApprovalError) throw cause
    approvalError(
      E3_APPROVAL_ERROR.INVALID_STATEMENT,
      'Approval statement primitive binding is invalid',
      {},
      cause
    )
  }
}

function assertBinding(actual, expected, label) {
  for (const [field, value] of Object.entries(expected)) {
    if (actual[field] !== value) {
      approvalError(
        E3_APPROVAL_ERROR.HASH_BINDING_MISMATCH,
        `${label} does not match ${field}`,
        { field }
      )
    }
  }
}

export class ApprovalGate {
  constructor(database, {
    artifactRoot,
    env = {},
    idFactory = randomUUID,
    faultInjector = () => {}
  }) {
    this.database = database
    this.store = new ArtifactStore(artifactRoot)
    this.sessions = new EditorRepository(database)
    this.enabled = approvalGateFeatureEnabled(env)
    this.idFactory = idFactory
    this.faultInjector = faultInjector
  }

  getForRequest(sessionId, requestId) {
    assertCanonicalSessionId(sessionId)
    assertSafeToken(requestId, 'requestId', {
      minLength: 8,
      maxLength: 160
    })
    return rowToApproval(this.database.prepare(`
      SELECT * FROM editor_approval_records
      WHERE session_id = ? AND request_id = ?
    `).get(sessionId, requestId))
  }

  getById(id) {
    assertCanonicalSessionId(id)
    return rowToApproval(this.database.prepare(`
      SELECT * FROM editor_approval_records WHERE id = ?
    `).get(id))
  }

  #readArtifact(id, sessionId, sha256, type) {
    const artifact = this.database.prepare(`
      SELECT * FROM editor_artifacts WHERE id = ?
    `).get(id)
    if (
      !artifact ||
      artifact.session_id !== sessionId ||
      artifact.artifact_type !== type ||
      artifact.sha256 !== sha256
    ) {
      approvalError(
        E3_APPROVAL_ERROR.HASH_BINDING_MISMATCH,
        'Approval artifact metadata does not match its binding',
        { type }
      )
    }
    try {
      return this.store.read(sha256)
    } catch (cause) {
      approvalError(
        E3_APPROVAL_ERROR.ARTIFACT_TAMPERED,
        'Approval artifact verification failed',
        { type },
        cause
      )
    }
  }

  #loadAndVerifyReview(input, session) {
    const review = this.database.prepare(`
      SELECT * FROM editor_review_sets
      WHERE id = ? AND session_id = ?
    `).get(input.reviewSetId, input.sessionId)
    if (!review) {
      approvalError(
        E3_APPROVAL_ERROR.HASH_BINDING_MISMATCH,
        'Approval review set does not exist'
      )
    }
    if (review.session_version !== input.expectedVersion) {
      approvalError(
        E3_APPROVAL_ERROR.STALE_SESSION,
        'Approval review set belongs to another session version'
      )
    }
    const candidate = this.database.prepare(`
      SELECT * FROM editor_candidate_artifact_sets
      WHERE id = ? AND session_id = ?
    `).get(review.candidate_set_id, input.sessionId)
    if (!candidate) {
      approvalError(
        E3_APPROVAL_ERROR.HASH_BINDING_MISMATCH,
        'Approval candidate set does not exist'
      )
    }
    assertBinding(candidate, {
      base_commit: session.baseCommit,
      candidate_manifest_sha256:
        review.candidate_manifest_sha256,
      forward_patch_sha256: review.forward_patch_sha256,
      path_policy_version: review.path_policy_version
    }, 'Candidate set')
    assertBinding(session.candidate ?? {}, {
      candidateManifestSha256:
        review.candidate_manifest_sha256,
      patchSha256: review.forward_patch_sha256,
      validationManifestSha256:
        review.validation_manifest_sha256,
      pathPolicyVersion: review.path_policy_version,
      profileSetVersion: review.profile_set_version
    }, 'Frozen session candidate')

    const candidateBytes = {}
    for (const [idField, shaField, type] of CANDIDATE_ARTIFACTS) {
      candidateBytes[type] = this.#readArtifact(
        candidate[idField],
        input.sessionId,
        candidate[shaField],
        type
      )
    }
    const candidateManifest = parseJson(
      candidateBytes[E3_ARTIFACT_TYPE.CANDIDATE_MANIFEST],
      'Candidate manifest'
    )
    assertCanonicalJson(
      candidateBytes[E3_ARTIFACT_TYPE.CANDIDATE_MANIFEST],
      candidateManifest,
      'Candidate manifest'
    )
    assertBinding(candidateManifest, {
      sessionId: input.sessionId,
      sessionVersion: candidate.session_version,
      baseCommit: session.baseCommit,
      treeSha: candidate.tree_sha,
      pathPolicyVersion: review.path_policy_version
    }, 'Candidate manifest')

    const validationBytes = this.#readArtifact(
      review.validation_manifest_artifact_id,
      input.sessionId,
      review.validation_manifest_sha256,
      E3_ARTIFACT_TYPE.VALIDATION_MANIFEST
    )
    const summaryBytes = this.#readArtifact(
      review.review_summary_artifact_id,
      input.sessionId,
      review.review_summary_sha256,
      E3_ARTIFACT_TYPE.REVIEW_SUMMARY
    )
    const validationManifest = parseJson(
      validationBytes,
      'Validation manifest'
    )
    const reviewSummary = parseJson(summaryBytes, 'Review summary')
    assertCanonicalJson(
      validationBytes,
      validationManifest,
      'Validation manifest'
    )
    assertCanonicalJson(summaryBytes, reviewSummary, 'Review summary')
    assertBinding(validationManifest, {
      sessionId: input.sessionId,
      baseCommit: session.baseCommit,
      candidateSetId: candidate.id,
      candidateManifestSha256:
        candidate.candidate_manifest_sha256,
      profileSetVersion: review.profile_set_version,
      profileSetSha256: review.profile_set_sha256,
      reviewPolicySha256: review.review_policy_sha256
    }, 'Validation manifest')
    assertBinding(reviewSummary, {
      sessionId: input.sessionId,
      baseCommit: session.baseCommit,
      candidateSetId: candidate.id,
      validationManifestSha256:
        review.validation_manifest_sha256,
      reviewPolicyVersion: review.review_policy_version,
      reviewPolicySha256: review.review_policy_sha256
    }, 'Review summary')
    assertBinding(reviewSummary.artifacts ?? {}, {
      candidateManifestSha256:
        candidate.candidate_manifest_sha256,
      forwardPatchSha256: candidate.forward_patch_sha256,
      reversePatchSha256: candidate.reverse_patch_sha256,
      unifiedDiffSha256: candidate.unified_diff_sha256,
      diffStatSha256: candidate.diff_stat_sha256
    }, 'Review summary artifacts')

    let evidenceIds
    try {
      evidenceIds = JSON.parse(review.validation_evidence_json)
    } catch (cause) {
      approvalError(
        E3_APPROVAL_ERROR.ARTIFACT_TAMPERED,
        'Review evidence list is invalid',
        {},
        cause
      )
    }
    if (
      !Array.isArray(evidenceIds) ||
      evidenceIds.length === 0 ||
      new Set(evidenceIds).size !== evidenceIds.length
    ) {
      approvalError(
        E3_APPROVAL_ERROR.HASH_BINDING_MISMATCH,
        'Review evidence list is invalid or contains duplicates'
      )
    }
    const placeholders = evidenceIds.map(() => '?').join(', ')
    const evidenceRows = this.database.prepare(`
      SELECT e.*, a.sha256 AS log_sha256,
        a.artifact_type AS log_artifact_type,
        a.session_id AS log_session_id
      FROM editor_validation_evidence e
      JOIN editor_artifacts a ON a.id = e.log_artifact_id
      WHERE e.id IN (${placeholders})
    `).all(...evidenceIds)
    if (evidenceRows.length !== evidenceIds.length) {
      approvalError(
        E3_APPROVAL_ERROR.HASH_BINDING_MISMATCH,
        'Review validation evidence is incomplete'
      )
    }
    if (
      !Array.isArray(validationManifest.validations) ||
      validationManifest.validations.length !== evidenceIds.length ||
      validationManifest.validations.some(
        (item, index) => item?.runId !== evidenceIds[index]
      )
    ) {
      approvalError(
        E3_APPROVAL_ERROR.HASH_BINDING_MISMATCH,
        'Validation manifest does not bind the canonical evidence order'
      )
    }
    const evidenceById = new Map(
      evidenceRows.map(evidence => [evidence.id, evidence])
    )
    for (const validation of validationManifest.validations) {
      const evidence = evidenceById.get(validation.runId)
      if (
        !evidence ||
        evidence.session_id !== input.sessionId ||
        evidence.candidate_set_id !== candidate.id ||
        evidence.candidate_manifest_sha256 !==
          candidate.candidate_manifest_sha256 ||
        evidence.profile_set_version !==
          review.profile_set_version ||
        evidence.profile_set_sha256 !== review.profile_set_sha256 ||
        evidence.status !== 'SUCCEEDED' ||
        evidence.log_artifact_type !==
          E3_ARTIFACT_TYPE.VALIDATION_LOG ||
        evidence.log_session_id !== input.sessionId
      ) {
        approvalError(
          E3_APPROVAL_ERROR.HASH_BINDING_MISMATCH,
          'Validation evidence does not match the review set'
        )
      }
      assertExactFields(validation, [
        'runId',
        'profileId',
        'profileVersion',
        'profileSha256',
        'requestSha256',
        'planSha256',
        'logSha256',
        'status',
        'exitCode',
        'signal'
      ])
      assertBinding(validation, {
        runId: evidence.id,
        profileId: evidence.profile_id,
        profileVersion: evidence.profile_version,
        profileSha256: evidence.profile_sha256,
        requestSha256: evidence.request_sha256,
        planSha256: evidence.plan_sha256,
        logSha256: evidence.log_sha256,
        status: evidence.status,
        exitCode: evidence.exit_code,
        signal: evidence.signal
      }, 'Validation manifest entry')
      try {
        this.store.read(evidence.log_sha256)
      } catch (cause) {
        approvalError(
          E3_APPROVAL_ERROR.ARTIFACT_TAMPERED,
          'Validation log verification failed',
          { evidenceId: evidence.id },
          cause
        )
      }
    }
    return { review, candidate }
  }

  #expectedStatement(input, session, review, candidate) {
    return {
      version: 1,
      decision: E3_APPROVAL_DECISION.APPROVE,
      sessionId: input.sessionId,
      baseCommit: session.baseCommit,
      sessionVersion: input.expectedVersion,
      reviewSetId: review.id,
      candidateSetId: candidate.id,
      candidateManifestSha256:
        review.candidate_manifest_sha256,
      forwardPatchSha256: review.forward_patch_sha256,
      validationManifestSha256:
        review.validation_manifest_sha256,
      reviewSummarySha256: review.review_summary_sha256,
      pathPolicyVersion: review.path_policy_version,
      profileSetVersion: review.profile_set_version,
      profileSetSha256: review.profile_set_sha256,
      reviewPolicyVersion: review.review_policy_version,
      reviewPolicySha256: review.review_policy_sha256,
      approvalPolicyVersion: E3_APPROVAL_POLICY_VERSION,
      approvalPolicySha256: E3_APPROVAL_POLICY_SHA256,
      actorId: input.actorId,
      occurredAt: input.occurredAt
    }
  }

  #verifyPersistedApproval(approval) {
    assertExactFields(
      approval.statement,
      E3_APPROVAL_STATEMENT_FIELDS
    )
    assertStatementPrimitives(approval.statement)
    const bytes = Buffer.from(
      canonicalApprovalJson(approval.statement),
      'utf8'
    )
    if (
      approval.statementSha256 !== approvalSha256(bytes) ||
      approval.approvalPolicyVersion !==
        E3_APPROVAL_POLICY_VERSION ||
      approval.approvalPolicySha256 !==
        E3_APPROVAL_POLICY_SHA256
    ) {
      approvalError(
        E3_APPROVAL_ERROR.HASH_BINDING_MISMATCH,
        'Persisted approval record failed verification'
      )
    }
    assertBinding(approval.statement, {
      version: 1,
      decision: approval.decision,
      sessionId: approval.sessionId,
      baseCommit: approval.baseCommit,
      sessionVersion: approval.reviewSessionVersion,
      reviewSetId: approval.reviewSetId,
      candidateSetId: approval.candidateSetId,
      candidateManifestSha256:
        approval.candidateManifestSha256,
      forwardPatchSha256: approval.forwardPatchSha256,
      validationManifestSha256:
        approval.validationManifestSha256,
      reviewSummarySha256: approval.reviewSummarySha256,
      pathPolicyVersion: approval.pathPolicyVersion,
      profileSetVersion: approval.profileSetVersion,
      profileSetSha256: approval.profileSetSha256,
      reviewPolicyVersion: approval.reviewPolicyVersion,
      reviewPolicySha256: approval.reviewPolicySha256,
      approvalPolicyVersion: approval.approvalPolicyVersion,
      approvalPolicySha256: approval.approvalPolicySha256,
      actorId: approval.actorId,
      occurredAt: approval.createdAt
    }, 'Persisted approval statement')
    const session = this.sessions.getSession(approval.sessionId)
    if (
      session?.status !== E3_SESSION_STATUS.APPROVED ||
      session.version !== approval.approvedSessionVersion
    ) {
      approvalError(
        E3_APPROVAL_ERROR.HASH_BINDING_MISMATCH,
        'Persisted approval does not match the approved session'
      )
    }
    assertBinding(session.approval ?? {}, {
      sessionId: approval.sessionId,
      baseCommit: approval.baseCommit,
      candidateManifestSha256:
        approval.candidateManifestSha256,
      patchSha256: approval.forwardPatchSha256,
      validationManifestSha256:
        approval.validationManifestSha256,
      pathPolicyVersion: approval.pathPolicyVersion,
      profileSetVersion: approval.profileSetVersion,
      approvedBy: approval.actorId,
      approvedAt: approval.createdAt
    }, 'Approved session binding')
    this.#loadAndVerifyReview({
      sessionId: approval.sessionId,
      reviewSetId: approval.reviewSetId,
      expectedVersion: approval.reviewSessionVersion
    }, {
      ...session,
      status: E3_SESSION_STATUS.READY_FOR_REVIEW,
      version: approval.reviewSessionVersion,
      candidate: {
        candidateManifestSha256:
          approval.candidateManifestSha256,
        patchSha256: approval.forwardPatchSha256,
        validationManifestSha256:
          approval.validationManifestSha256,
        pathPolicyVersion: approval.pathPolicyVersion,
        profileSetVersion: approval.profileSetVersion
      }
    })
  }

  approve(input) {
    if (!this.enabled) {
      approvalError(
        E3_APPROVAL_ERROR.FEATURE_DISABLED,
        'E3 approval gate is disabled'
      )
    }
    assertEnvelope(input)
    assertStatementPrimitives(input.statement)
    const statementBytes = Buffer.from(
      canonicalApprovalJson(input.statement),
      'utf8'
    )
    const statementSha256 = approvalSha256(statementBytes)
    const requestSha256 = approvalSha256({
      version: 1,
      sessionId: input.sessionId,
      expectedVersion: input.expectedVersion,
      reviewSetId: input.reviewSetId,
      actorId: input.actorId,
      requestId: input.requestId,
      occurredAt: input.occurredAt,
      leaseOwner: input.leaseOwner,
      fencingToken: input.fencingToken,
      statementSha256
    })
    const existing = this.getForRequest(
      input.sessionId,
      input.requestId
    )
    if (existing) {
      if (existing.requestSha256 !== requestSha256) {
        approvalError(
          E3_APPROVAL_ERROR.IDEMPOTENCY_CONFLICT,
          'Approval request ID was reused for another request'
        )
      }
      this.#verifyPersistedApproval(existing)
      return freezeDomainValue({
        approval: existing,
        session: this.sessions.getSession(input.sessionId),
        replayed: true
      })
    }

    const session = this.sessions.getSession(input.sessionId)
    if (session?.status !== E3_SESSION_STATUS.READY_FOR_REVIEW) {
      approvalError(
        E3_APPROVAL_ERROR.SESSION_NOT_READY,
        'Approval requires a session ready for review'
      )
    }
    if (session.version !== input.expectedVersion) {
      approvalError(
        E3_APPROVAL_ERROR.STALE_SESSION,
        'Approval received a stale session version'
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
      approvalError(
        E3_APPROVAL_ERROR.LEASE_REQUIRED,
        'Approval requires the current unexpired session lease'
      )
    }
    const verified = this.#loadAndVerifyReview(input, session)
    const expectedStatement = this.#expectedStatement(
      input,
      session,
      verified.review,
      verified.candidate
    )
    assertBinding(
      input.statement,
      expectedStatement,
      'Approval statement'
    )
    const approvalId = this.idFactory()
    assertCanonicalSessionId(approvalId)

    try {
      return this.database.transaction(() => {
        const currentSession = this.sessions.getSession(input.sessionId)
        if (
          currentSession?.status !== E3_SESSION_STATUS.READY_FOR_REVIEW ||
          currentSession.version !== input.expectedVersion
        ) {
          approvalError(
            E3_APPROVAL_ERROR.STALE_SESSION,
            'Session changed before approval commit'
          )
        }
        this.#loadAndVerifyReview(input, currentSession)
        const transition = this.sessions.transitionSession({
          type: E3_SESSION_COMMAND.APPROVE,
          sessionId: input.sessionId,
          expectedVersion: input.expectedVersion,
          actorId: input.actorId,
          requestId: input.requestId,
          occurredAt: input.occurredAt,
          leaseOwner: input.leaseOwner,
          fencingToken: input.fencingToken,
          binding: {
            sessionId: input.sessionId,
            baseCommit: currentSession.baseCommit,
            ...currentSession.candidate
          }
        })
        this.faultInjector('approval.after_transition')
        this.database.prepare(`
          INSERT INTO editor_approval_records (
            id, session_id, review_session_version,
            approved_session_version, review_set_id,
            candidate_set_id, base_commit,
            candidate_manifest_sha256, forward_patch_sha256,
            validation_manifest_sha256, review_summary_sha256,
            path_policy_version, profile_set_version,
            profile_set_sha256, review_policy_version,
            review_policy_sha256, approval_policy_version,
            approval_policy_sha256, decision, statement_json,
            statement_sha256, request_sha256, actor_id,
            request_id, created_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?, ?
          )
        `).run(
          approvalId,
          input.sessionId,
          input.expectedVersion,
          transition.session.version,
          verified.review.id,
          verified.candidate.id,
          currentSession.baseCommit,
          verified.review.candidate_manifest_sha256,
          verified.review.forward_patch_sha256,
          verified.review.validation_manifest_sha256,
          verified.review.review_summary_sha256,
          verified.review.path_policy_version,
          verified.review.profile_set_version,
          verified.review.profile_set_sha256,
          verified.review.review_policy_version,
          verified.review.review_policy_sha256,
          E3_APPROVAL_POLICY_VERSION,
          E3_APPROVAL_POLICY_SHA256,
          E3_APPROVAL_DECISION.APPROVE,
          statementBytes.toString('utf8'),
          statementSha256,
          requestSha256,
          input.actorId,
          input.requestId,
          input.occurredAt
        )
        this.faultInjector('approval.after_record')
        return freezeDomainValue({
          ...transition,
          approval: this.getById(approvalId)
        })
      }).immediate()
    } catch (cause) {
      if (cause instanceof E3ApprovalError) throw cause
      if (
        cause?.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
        String(cause?.message).includes('UNIQUE constraint failed')
      ) {
        approvalError(
          E3_APPROVAL_ERROR.APPROVAL_CONFLICT,
          'A conflicting approval already exists',
          {},
          cause
        )
      }
      approvalError(
        E3_APPROVAL_ERROR.PERSISTENCE_FAILED,
        'Approval publication failed',
        {},
        cause
      )
    }
  }
}
