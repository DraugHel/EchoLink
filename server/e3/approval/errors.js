export const E3_APPROVAL_ERROR = Object.freeze({
  FEATURE_DISABLED: 'FEATURE_DISABLED',
  INVALID_REQUEST: 'INVALID_REQUEST',
  INVALID_STATEMENT: 'INVALID_STATEMENT',
  HASH_BINDING_MISMATCH: 'HASH_BINDING_MISMATCH',
  ARTIFACT_TAMPERED: 'ARTIFACT_TAMPERED',
  SESSION_NOT_READY: 'SESSION_NOT_READY',
  STALE_SESSION: 'STALE_SESSION',
  LEASE_REQUIRED: 'LEASE_REQUIRED',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  APPROVAL_CONFLICT: 'APPROVAL_CONFLICT',
  PERSISTENCE_FAILED: 'PERSISTENCE_FAILED'
})

export class E3ApprovalError extends Error {
  constructor(code, message, details = {}, options = {}) {
    super(message, options)
    this.name = 'E3ApprovalError'
    this.code = code
    this.details = Object.freeze({ ...details })
  }
}
