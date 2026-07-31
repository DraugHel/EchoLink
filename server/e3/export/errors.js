export const E3_PILOT_EXPORT_ERROR = Object.freeze({
  FEATURE_DISABLED: 'FEATURE_DISABLED',
  INVALID_REQUEST: 'INVALID_REQUEST',
  SESSION_NOT_APPROVED: 'SESSION_NOT_APPROVED',
  STALE_SESSION: 'STALE_SESSION',
  LEASE_REQUIRED: 'LEASE_REQUIRED',
  APPROVAL_MISMATCH: 'APPROVAL_MISMATCH',
  ARTIFACT_TAMPERED: 'ARTIFACT_TAMPERED',
  PACKAGE_INVALID: 'PACKAGE_INVALID',
  PACKAGE_TOO_LARGE: 'PACKAGE_TOO_LARGE',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  EXPORT_CONFLICT: 'EXPORT_CONFLICT',
  PERSISTENCE_FAILED: 'PERSISTENCE_FAILED'
})

export class E3PilotExportError extends Error {
  constructor(code, message, details = {}, options = {}) {
    super(message, options)
    this.name = 'E3PilotExportError'
    this.code = code
    this.details = Object.freeze({ ...details })
  }
}
