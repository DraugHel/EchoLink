import { createHash } from 'node:crypto'

export const E3_PILOT_EXPORT_FEATURE_FLAG =
  'E3_PILOT_EXPORT_ENABLED'
export const E3_PILOT_EXPORT_POLICY_VERSION =
  'e3-pilot-export-policy-v1'
export const E3_PILOT_EXPORT_FORMAT = 'ustar-v1'

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, canonical(value[key])])
    )
  }
  return value
}

export function canonicalExportJson(value) {
  return `${JSON.stringify(canonical(value), null, 2)}\n`
}

export function exportSha256(value) {
  return createHash('sha256')
    .update(
      typeof value === 'string' || Buffer.isBuffer(value)
        ? value
        : canonicalExportJson(value)
    )
    .digest('hex')
}

export const E3_PILOT_EXPORT_POLICY = Object.freeze({
  version: E3_PILOT_EXPORT_POLICY_VERSION,
  format: E3_PILOT_EXPORT_FORMAT,
  compression: 'none',
  manualApplyOnly: true,
  productiveApplyEnabled: false,
  includeCandidateArtifacts: true,
  includeReviewArtifacts: true,
  includeApprovalStatement: true,
  includeValidationLogs: true,
  requireCurrentApproval: true,
  requireCurrentLease: true,
  singleExportPerApproval: true,
  maxPackageBytes: 128 * 1024 * 1024
})

export const E3_PILOT_EXPORT_POLICY_SHA256 =
  exportSha256(E3_PILOT_EXPORT_POLICY)


export const E3_PILOT_EXPORT_MANIFEST_FIELDS = Object.freeze([
  'version',
  'format',
  'exportPolicyVersion',
  'exportPolicySha256',
  'manualApplyOnly',
  'productiveApplyEnabled',
  'sessionId',
  'approvedSessionVersion',
  'exportedSessionVersion',
  'baseCommit',
  'approvalId',
  'approvalStatementSha256',
  'approvalActorId',
  'approvedAt',
  'reviewSetId',
  'candidateSetId',
  'candidateManifestSha256',
  'forwardPatchSha256',
  'reversePatchSha256',
  'unifiedDiffSha256',
  'diffStatSha256',
  'validationManifestSha256',
  'reviewSummarySha256',
  'pathPolicyVersion',
  'profileSetVersion',
  'profileSetSha256',
  'reviewPolicyVersion',
  'reviewPolicySha256',
  'approvalPolicyVersion',
  'approvalPolicySha256',
  'generatedBy',
  'generatedAt',
  'checksumsPath',
  'files'
])

export const E3_PILOT_EXPORT_REQUEST_FIELDS = Object.freeze([
  'sessionId',
  'expectedVersion',
  'approvalId',
  'actorId',
  'requestId',
  'occurredAt',
  'leaseOwner',
  'fencingToken'
])

export function pilotExportFeatureEnabled(env = {}) {
  return env[E3_PILOT_EXPORT_FEATURE_FLAG] === 'true'
}
