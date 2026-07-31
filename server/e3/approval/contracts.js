import { createHash } from 'node:crypto'

export const E3_APPROVAL_GATE_FEATURE_FLAG =
  'E3_APPROVAL_GATE_ENABLED'
export const E3_APPROVAL_POLICY_VERSION =
  'e3-approval-policy-v1'

export const E3_APPROVAL_DECISION = Object.freeze({
  APPROVE: 'APPROVE'
})

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, canonical(value[key])])
    )
  }
  return value
}

export function canonicalApprovalJson(value) {
  return `${JSON.stringify(canonical(value), null, 2)}\n`
}

export function approvalSha256(value) {
  return createHash('sha256')
    .update(
      typeof value === 'string' || Buffer.isBuffer(value)
        ? value
        : canonicalApprovalJson(value)
    )
    .digest('hex')
}

export const E3_APPROVAL_POLICY = Object.freeze({
  version: E3_APPROVAL_POLICY_VERSION,
  decision: E3_APPROVAL_DECISION.APPROVE,
  requireCurrentReviewSet: true,
  requireCurrentSessionVersion: true,
  requireCurrentLease: true,
  requireVerifiedCandidateArtifacts: true,
  requireVerifiedReviewArtifacts: true,
  requireVerifiedValidationEvidence: true,
  requireExactStatementBinding: true,
  singleApprovalPerReviewSet: true
})

export const E3_APPROVAL_POLICY_SHA256 =
  approvalSha256(E3_APPROVAL_POLICY)

export const E3_APPROVAL_STATEMENT_FIELDS = Object.freeze([
  'version',
  'decision',
  'sessionId',
  'baseCommit',
  'sessionVersion',
  'reviewSetId',
  'candidateSetId',
  'candidateManifestSha256',
  'forwardPatchSha256',
  'validationManifestSha256',
  'reviewSummarySha256',
  'pathPolicyVersion',
  'profileSetVersion',
  'profileSetSha256',
  'reviewPolicyVersion',
  'reviewPolicySha256',
  'approvalPolicyVersion',
  'approvalPolicySha256',
  'actorId',
  'occurredAt'
])

export function approvalGateFeatureEnabled(env = {}) {
  return env[E3_APPROVAL_GATE_FEATURE_FLAG] === 'true'
}
