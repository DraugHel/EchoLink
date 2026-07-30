export const E3_VALIDATION_ERROR = Object.freeze({
  INVALID_REQUEST: 'INVALID_REQUEST',
  UNSUPPORTED_REQUEST_VERSION: 'UNSUPPORTED_REQUEST_VERSION',
  UNKNOWN_PROFILE: 'UNKNOWN_PROFILE',
  PROFILE_VERSION_MISMATCH: 'PROFILE_VERSION_MISMATCH',
  PROFILE_SET_MISMATCH: 'PROFILE_SET_MISMATCH',
  INVALID_IMAGE_DIGEST: 'INVALID_IMAGE_DIGEST',
  RUNTIME_VERSION_MISMATCH: 'RUNTIME_VERSION_MISMATCH',
  UNSAFE_PROFILE: 'UNSAFE_PROFILE'
})

export class E3ValidationError extends Error {
  constructor(code, message, details = {}, options = {}) {
    super(message, options)
    this.name = 'E3ValidationError'
    this.code = code
    this.details = Object.freeze({ ...details })
  }
}
