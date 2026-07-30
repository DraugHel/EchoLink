import { Buffer } from 'node:buffer'
import {
  assertCanonicalSessionId,
  assertFencingToken,
  assertSafeToken,
  assertSha256,
  assertTimestamp
} from '../core/contracts.js'
import {
  E3_VALIDATION_LIMITS,
  E3_VALIDATION_REQUEST_VERSION
} from './contracts.js'
import {
  E3_VALIDATION_ERROR,
  E3ValidationError
} from './errors.js'

const REQUIRED_FIELDS = Object.freeze([
  'version',
  'runId',
  'sessionId',
  'candidateSetId',
  'candidateManifestSha256',
  'snapshotHandle',
  'profileId',
  'profileVersion',
  'profileSetSha256',
  'requestedAt',
  'leaseOwner',
  'fencingToken'
])

function requestError(message, details = {}) {
  throw new E3ValidationError(
    E3_VALIDATION_ERROR.INVALID_REQUEST,
    message,
    details
  )
}

function assertExactFields(request) {
  const actual = Object.keys(request).sort()
  const expected = [...REQUIRED_FIELDS].sort()
  const unknown = actual.filter(key => !expected.includes(key))
  const missing = expected.filter(key => !actual.includes(key))
  if (unknown.length > 0 || missing.length > 0) {
    requestError(
      'Validation request fields do not match the V1 schema',
      { unknown, missing }
    )
  }
}

export function validateValidationRequest(request) {
  if (
    !request ||
    typeof request !== 'object' ||
    Array.isArray(request)
  ) {
    requestError('Validation request must be an object')
  }
  let serialized
  try {
    serialized = JSON.stringify(request)
  } catch {
    requestError('Validation request must be JSON-compatible')
  }
  if (
    Buffer.byteLength(serialized, 'utf8') >
    E3_VALIDATION_LIMITS.maxRequestBytes
  ) {
    requestError('Validation request exceeds the V1 byte limit')
  }
  assertExactFields(request)
  if (request.version !== E3_VALIDATION_REQUEST_VERSION) {
    throw new E3ValidationError(
      E3_VALIDATION_ERROR.UNSUPPORTED_REQUEST_VERSION,
      'Validation request version is unsupported'
    )
  }
  if (
    !Number.isSafeInteger(request.profileVersion) ||
    request.profileVersion < 1
  ) {
    requestError('profileVersion must be a positive integer')
  }
  assertCanonicalSessionId(request.runId)
  assertCanonicalSessionId(request.sessionId)
  assertCanonicalSessionId(request.candidateSetId)
  if (new Set([
    request.runId,
    request.sessionId,
    request.candidateSetId
  ]).size !== 3) {
    requestError(
      'runId, sessionId and candidateSetId must be distinct'
    )
  }
  assertSha256(
    request.candidateManifestSha256,
    'candidateManifestSha256'
  )
  assertSafeToken(request.snapshotHandle, 'snapshotHandle', {
    minLength: 8,
    maxLength: 160
  })
  assertSafeToken(request.profileId, 'profileId', {
    minLength: 3,
    maxLength: 80
  })
  assertSha256(request.profileSetSha256, 'profileSetSha256')
  assertTimestamp(request.requestedAt, 'requestedAt')
  assertSafeToken(request.leaseOwner, 'leaseOwner', {
    minLength: 3,
    maxLength: 160
  })
  assertFencingToken(request.fencingToken)
  return Object.freeze({ ...request })
}
