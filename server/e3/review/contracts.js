import { createHash } from 'node:crypto'
import {
  E3_VALIDATION_PROFILE_ID
} from '../validation/contracts.js'

export const E3_REVIEW_GATE_FEATURE_FLAG =
  'E3_REVIEW_GATE_ENABLED'
export const E3_REVIEW_POLICY_VERSION = 'e3-review-policy-v1'

export const E3_REVIEW_REQUIRED_PROFILES = Object.freeze([
  E3_VALIDATION_PROFILE_ID.DIFF_CHECK,
  E3_VALIDATION_PROFILE_ID.SYNTAX_JAVASCRIPT,
  E3_VALIDATION_PROFILE_ID.SYNTAX_JSON,
  E3_VALIDATION_PROFILE_ID.TEST_TARGETED,
  E3_VALIDATION_PROFILE_ID.TEST_FULL,
  E3_VALIDATION_PROFILE_ID.BUILD_FRONTEND,
  E3_VALIDATION_PROFILE_ID.SQLITE_INTEGRITY,
  E3_VALIDATION_PROFILE_ID.PLAYWRIGHT_UI
])

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, canonical(value[key])])
    )
  }
  return value
}

export function canonicalReviewJson(value) {
  return `${JSON.stringify(canonical(value), null, 2)}\n`
}

export function reviewSha256(value) {
  return createHash('sha256')
    .update(
      typeof value === 'string' || Buffer.isBuffer(value)
        ? value
        : canonicalReviewJson(value)
    )
    .digest('hex')
}

export const E3_REVIEW_POLICY = Object.freeze({
  version: E3_REVIEW_POLICY_VERSION,
  requiredProfiles: E3_REVIEW_REQUIRED_PROFILES,
  requireSucceeded: true,
  requireSingleCandidate: true,
  requireSingleProfileSet: true,
  requireVerifiedArtifacts: true
})

export const E3_REVIEW_POLICY_SHA256 =
  reviewSha256(E3_REVIEW_POLICY)

export function reviewGateFeatureEnabled(env = {}) {
  return env[E3_REVIEW_GATE_FEATURE_FLAG] === 'true'
}
