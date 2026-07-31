import { createHash } from 'node:crypto'

export const E3_RECOVERY_FEATURE_FLAG = 'E3_RECOVERY_ENABLED'
export const E3_RECOVERY_POLICY_VERSION = 'e3-recovery-policy-v1'
export const E3_RECOVERY_RESOURCE_TYPE = Object.freeze({
  WORKSPACE: 'workspace',
  UNKNOWN_WORKSPACE: 'unknown_workspace'
})
export const E3_RECOVERY_DECISION = Object.freeze({
  RETAIN_ACTIVE: 'RETAIN_ACTIVE',
  CLEANED: 'CLEANED',
  FINALIZED: 'FINALIZED',
  ALREADY_CLEAN: 'ALREADY_CLEAN',
  QUARANTINE_REQUIRED: 'QUARANTINE_REQUIRED'
})
export const E3_RECOVERY_REASON = Object.freeze({
  ACTIVE_SESSION: 'ACTIVE_SESSION',
  VALID_SESSION_LEASE: 'VALID_SESSION_LEASE',
  VALID_WORKSPACE_LEASE: 'VALID_WORKSPACE_LEASE',
  ACTIVE_VALIDATION: 'ACTIVE_VALIDATION',
  OPEN_OPERATION_INTENT: 'OPEN_OPERATION_INTENT',
  LIVE_PROCESS: 'LIVE_PROCESS',
  LIVE_CONTAINER: 'LIVE_CONTAINER',
  LIVE_PORT: 'LIVE_PORT',
  INSPECTOR_UNAVAILABLE: 'INSPECTOR_UNAVAILABLE',
  RETENTION_NOT_REACHED: 'RETENTION_NOT_REACHED',
  EXPORTED_WORKSPACE: 'EXPORTED_WORKSPACE',
  TERMINAL_WORKSPACE: 'TERMINAL_WORKSPACE',
  INTERRUPTED_REMOVAL: 'INTERRUPTED_REMOVAL',
  EXPORTED_ALREADY_REMOVED: 'EXPORTED_ALREADY_REMOVED',
  REMOVED_AND_ABSENT: 'REMOVED_AND_ABSENT',
  WORKSPACE_QUARANTINED: 'WORKSPACE_QUARANTINED',
  UNKNOWN_DIRECTORY: 'UNKNOWN_DIRECTORY',
  PATH_MISMATCH: 'PATH_MISMATCH',
  ROOT_MISSING: 'ROOT_MISSING',
  ROOT_UNSAFE: 'ROOT_UNSAFE',
  MANIFEST_MISSING: 'MANIFEST_MISSING',
  MANIFEST_TAMPERED: 'MANIFEST_TAMPERED',
  MANIFEST_MISMATCH: 'MANIFEST_MISMATCH',
  INVALID_ASSOCIATED_RESOURCE: 'INVALID_ASSOCIATED_RESOURCE',
  UNSUPPORTED_WORKSPACE_STATE: 'UNSUPPORTED_WORKSPACE_STATE'
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

export function canonicalRecoveryJson(value) {
  return `${JSON.stringify(canonical(value), null, 2)}\n`
}

export function recoverySha256(value) {
  return createHash('sha256')
    .update(
      typeof value === 'string' || Buffer.isBuffer(value)
        ? value
        : canonicalRecoveryJson(value)
    )
    .digest('hex')
}

export const E3_RECOVERY_POLICY = Object.freeze({
  version: E3_RECOVERY_POLICY_VERSION,
  cleanupResourceKey: 'global',
  requireExpiredSessionLease: true,
  requireExpiredWorkspaceLease: true,
  requireNoLiveProcess: true,
  requireNoLiveContainer: true,
  requireNoLivePort: true,
  requireNoActiveValidation: true,
  requireNoOpenOperationIntent: true,
  completedRetentionMs: 0,
  exportedRetentionMs: 0,
  failedRetentionMs: 24 * 60 * 60 * 1000,
  leaseDurationMinMs: 60_000,
  leaseDurationMaxMs: 15 * 60 * 1000,
  moveUnknownResources: false,
  recursiveDeleteUnknownPaths: false,
  productiveApplyEnabled: false
})

export const E3_RECOVERY_POLICY_SHA256 =
  recoverySha256(E3_RECOVERY_POLICY)

export const E3_RECOVERY_REQUEST_FIELDS = Object.freeze([
  'runId',
  'actorId',
  'requestId',
  'occurredAt',
  'cleanupLeaseOwner',
  'cleanupFencingToken',
  'leaseDurationMs'
])

export function recoveryFeatureEnabled(env = {}) {
  return env[E3_RECOVERY_FEATURE_FLAG] === 'true'
}
