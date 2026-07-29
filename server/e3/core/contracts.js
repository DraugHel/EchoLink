const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const TOKEN_PATTERN = /^[A-Za-z0-9._:-]+$/

function enumValues(definition) {
  return Object.freeze(Object.values(definition))
}

export const E3_SESSION_STATUS = Object.freeze({
  CREATED: 'CREATED',
  PROVISIONING: 'PROVISIONING',
  EDITING: 'EDITING',
  VALIDATING: 'VALIDATING',
  READY_FOR_REVIEW: 'READY_FOR_REVIEW',
  APPROVED: 'APPROVED',
  EXPORTING: 'EXPORTING',
  EXPORTED: 'EXPORTED',
  COMPLETED: 'COMPLETED',
  RECOVERING: 'RECOVERING',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  STALE: 'STALE',
  CONFLICTED: 'CONFLICTED',
  APPLYING: 'APPLYING',
  APPLIED: 'APPLIED',
  FINAL_VERIFYING: 'FINAL_VERIFYING',
  REVERTING: 'REVERTING',
  REVERTED: 'REVERTED'
})

export const E3_SESSION_STATUSES =
  enumValues(E3_SESSION_STATUS)

export const E3_RESERVED_SESSION_STATUSES = Object.freeze([
  E3_SESSION_STATUS.APPLYING,
  E3_SESSION_STATUS.APPLIED,
  E3_SESSION_STATUS.FINAL_VERIFYING,
  E3_SESSION_STATUS.REVERTING,
  E3_SESSION_STATUS.REVERTED
])

export const E3_TERMINAL_SESSION_STATUSES = Object.freeze([
  E3_SESSION_STATUS.COMPLETED,
  E3_SESSION_STATUS.FAILED,
  E3_SESSION_STATUS.CANCELLED,
  E3_SESSION_STATUS.CONFLICTED,
  E3_SESSION_STATUS.REVERTED
])

export const E3_SESSION_COMMAND = Object.freeze({
  START_PROVISIONING: 'START_PROVISIONING',
  FINISH_PROVISIONING: 'FINISH_PROVISIONING',
  RECORD_MUTATION: 'RECORD_MUTATION',
  START_VALIDATION: 'START_VALIDATION',
  RECORD_VALIDATION_FAILURE: 'RECORD_VALIDATION_FAILURE',
  MARK_READY_FOR_REVIEW: 'MARK_READY_FOR_REVIEW',
  REOPEN_FOR_EDITING: 'REOPEN_FOR_EDITING',
  APPROVE: 'APPROVE',
  START_EXPORT: 'START_EXPORT',
  FINISH_EXPORT: 'FINISH_EXPORT',
  COMPLETE: 'COMPLETE',
  FAIL: 'FAIL',
  CANCEL: 'CANCEL',
  MARK_STALE: 'MARK_STALE',
  START_RECOVERY: 'START_RECOVERY',
  FINISH_RECOVERY: 'FINISH_RECOVERY',
  MARK_CONFLICTED: 'MARK_CONFLICTED',
  START_APPLY: 'START_APPLY',
  START_REVERT: 'START_REVERT'
})

export const E3_SESSION_COMMANDS =
  enumValues(E3_SESSION_COMMAND)

export const E3_RESERVED_SESSION_COMMANDS = Object.freeze([
  E3_SESSION_COMMAND.START_APPLY,
  E3_SESSION_COMMAND.START_REVERT
])

export const E3_EVENT_TYPE = Object.freeze({
  SESSION_CREATED: 'SESSION_CREATED',
  PROVISIONING_STARTED: 'PROVISIONING_STARTED',
  PROVISIONING_FINISHED: 'PROVISIONING_FINISHED',
  MUTATION_RECORDED: 'MUTATION_RECORDED',
  VALIDATION_STARTED: 'VALIDATION_STARTED',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  REVIEW_READY: 'REVIEW_READY',
  REVIEW_REOPENED: 'REVIEW_REOPENED',
  SESSION_APPROVED: 'SESSION_APPROVED',
  EXPORT_STARTED: 'EXPORT_STARTED',
  EXPORT_FINISHED: 'EXPORT_FINISHED',
  SESSION_COMPLETED: 'SESSION_COMPLETED',
  SESSION_FAILED: 'SESSION_FAILED',
  SESSION_CANCELLED: 'SESSION_CANCELLED',
  SESSION_STALE: 'SESSION_STALE',
  RECOVERY_STARTED: 'RECOVERY_STARTED',
  RECOVERY_FINISHED: 'RECOVERY_FINISHED',
  SESSION_CONFLICTED: 'SESSION_CONFLICTED'
})

export const E3_EVENT_TYPES = enumValues(E3_EVENT_TYPE)

export const E3_OPERATION_TYPE = Object.freeze({
  CREATE_FILE: 'create_file',
  REPLACE_EXACT: 'replace_exact',
  INSERT_BEFORE: 'insert_before',
  INSERT_AFTER: 'insert_after',
  RENAME_FILE: 'rename_file',
  MOVE_FILE: 'move_file',
  DELETE_FILE: 'delete_file'
})

export const E3_OPERATION_TYPES =
  enumValues(E3_OPERATION_TYPE)

export const E3_ARTIFACT_TYPE = Object.freeze({
  CANDIDATE_MANIFEST: 'candidate_manifest',
  FORWARD_PATCH: 'forward_patch',
  REVERSE_PATCH: 'reverse_patch',
  UNIFIED_DIFF: 'unified_diff',
  DIFF_STAT: 'diff_stat',
  VALIDATION_MANIFEST: 'validation_manifest',
  VALIDATION_LOG: 'validation_log',
  SCREENSHOT: 'screenshot',
  REVIEW_SUMMARY: 'review_summary',
  EXPORT_PACKAGE: 'export_package'
})

export const E3_ARTIFACT_TYPES =
  enumValues(E3_ARTIFACT_TYPE)

export const E3_VALIDATION_STATUS = Object.freeze({
  QUEUED: 'QUEUED',
  RUNNING: 'RUNNING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  TIMED_OUT: 'TIMED_OUT'
})

export const E3_VALIDATION_STATUSES =
  enumValues(E3_VALIDATION_STATUS)

export const E3_LEASE_RESOURCE_TYPE = Object.freeze({
  SESSION: 'session',
  WORKSPACE: 'workspace',
  MIRROR_UPDATE: 'mirror_update',
  VALIDATION_RUN: 'validation_run',
  PORT: 'port',
  CLEANUP: 'cleanup',
  APPLY: 'apply'
})

export const E3_LEASE_RESOURCE_TYPES =
  enumValues(E3_LEASE_RESOURCE_TYPE)

export const E3_FAILURE_CODE = Object.freeze({
  INVALID_SESSION: 'INVALID_SESSION',
  INVALID_SESSION_ID: 'INVALID_SESSION_ID',
  INVALID_BASE_COMMIT: 'INVALID_BASE_COMMIT',
  INVALID_STATUS: 'INVALID_STATUS',
  INVALID_COMMAND: 'INVALID_COMMAND',
  INVALID_COMMAND_DATA: 'INVALID_COMMAND_DATA',
  SESSION_ID_MISMATCH: 'SESSION_ID_MISMATCH',
  STALE_VERSION: 'STALE_VERSION',
  LEASE_REQUIRED: 'LEASE_REQUIRED',
  LEASE_OWNER_MISMATCH: 'LEASE_OWNER_MISMATCH',
  STALE_FENCING_TOKEN: 'STALE_FENCING_TOKEN',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  APPLY_DISABLED: 'APPLY_DISABLED',
  CANDIDATE_REQUIRED: 'CANDIDATE_REQUIRED',
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  HASH_BINDING_MISMATCH: 'HASH_BINDING_MISMATCH',
  PROVISIONING_FAILED: 'PROVISIONING_FAILED',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  EXPORT_FAILED: 'EXPORT_FAILED',
  RECOVERY_FAILED: 'RECOVERY_FAILED',
  BASE_DIVERGED: 'BASE_DIVERGED',
  INTERNAL_ERROR: 'INTERNAL_ERROR'
})

export const E3_FAILURE_CODES = enumValues(E3_FAILURE_CODE)

export class E3DomainError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'E3DomainError'
    this.code = code
    this.details = Object.freeze({ ...details })
  }
}

export function isE3SessionStatus(value) {
  return E3_SESSION_STATUSES.includes(value)
}

export function isE3SessionCommand(value) {
  return E3_SESSION_COMMANDS.includes(value)
}

export function isE3FailureCode(value) {
  return E3_FAILURE_CODES.includes(value)
}

export function isCanonicalSessionId(value) {
  return (
    typeof value === 'string' &&
    SESSION_ID_PATTERN.test(value)
  )
}

export function isFullGitCommit(value) {
  return (
    typeof value === 'string' &&
    GIT_SHA_PATTERN.test(value)
  )
}

export function isSha256(value) {
  return (
    typeof value === 'string' &&
    SHA256_PATTERN.test(value)
  )
}

export function isSafeToken(value, {
  minLength = 1,
  maxLength = 160
} = {}) {
  return (
    typeof value === 'string' &&
    value.length >= minLength &&
    value.length <= maxLength &&
    TOKEN_PATTERN.test(value)
  )
}

export function assertCanonicalSessionId(value) {
  if (!isCanonicalSessionId(value)) {
    throw new E3DomainError(
      E3_FAILURE_CODE.INVALID_SESSION_ID,
      'Session ID must be a canonical lowercase UUID'
    )
  }
  return value
}

export function assertFullGitCommit(value) {
  if (!isFullGitCommit(value)) {
    throw new E3DomainError(
      E3_FAILURE_CODE.INVALID_BASE_COMMIT,
      'Base commit must be a full lowercase Git SHA'
    )
  }
  return value
}

export function assertSha256(value, fieldName = 'sha256') {
  if (!isSha256(value)) {
    throw new E3DomainError(
      E3_FAILURE_CODE.INVALID_COMMAND_DATA,
      `${fieldName} must be a lowercase SHA-256`,
      { fieldName }
    )
  }
  return value
}

export function assertSafeToken(value, fieldName, options) {
  if (!isSafeToken(value, options)) {
    throw new E3DomainError(
      E3_FAILURE_CODE.INVALID_COMMAND_DATA,
      `${fieldName} is invalid`,
      { fieldName }
    )
  }
  return value
}

export function assertTimestamp(value, fieldName = 'occurredAt') {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new E3DomainError(
      E3_FAILURE_CODE.INVALID_COMMAND_DATA,
      `${fieldName} must be a non-negative integer timestamp`,
      { fieldName }
    )
  }
  return value
}

export function assertVersion(value, fieldName = 'version') {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new E3DomainError(
      E3_FAILURE_CODE.INVALID_COMMAND_DATA,
      `${fieldName} must be a non-negative integer`,
      { fieldName }
    )
  }
  return value
}

export function assertFencingToken(
  value,
  fieldName = 'fencingToken'
) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new E3DomainError(
      E3_FAILURE_CODE.INVALID_COMMAND_DATA,
      `${fieldName} must be a positive integer`,
      { fieldName }
    )
  }
  return value
}

export function freezeDomainValue(value) {
  if (
    value === null ||
    typeof value !== 'object'
  ) {
    return value
  }

  for (const nested of Object.values(value)) {
    freezeDomainValue(nested)
  }

  return Object.isFrozen(value)
    ? value
    : Object.freeze(value)
}
