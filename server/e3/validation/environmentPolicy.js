import {
  E3_VALIDATION_UI_NETWORK
} from './contracts.js'
import {
  E3_VALIDATION_ERROR,
  E3ValidationError
} from './errors.js'

const FIXED_ENVIRONMENT = Object.freeze({
  PATH: '/usr/bin:/bin',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  TZ: 'UTC',
  NODE_ENV: 'test',
  HOME: '/e3/empty-home',
  TMPDIR: '/e3/tmp'
})

const DYNAMIC_FIELDS = Object.freeze({
  E3_RUN_ID: 'runId',
  E3_SESSION_ID: 'sessionId',
  E3_SNAPSHOT_HANDLE: 'snapshotHandle',
  E3_CANDIDATE_MANIFEST_SHA256: 'candidateManifestSha256',
  E3_PROFILE_ID: 'profileId',
  E3_PROFILE_SHA256: 'profileSha256'
})

const OPTIONAL_FIELDS = Object.freeze({
  E3_TEST_ORIGIN: 'testOrigin'
})

export function buildValidationEnvironment(values) {
  const required = new Set(Object.values(DYNAMIC_FIELDS))
  const accepted = new Set([
    ...required,
    ...Object.values(OPTIONAL_FIELDS)
  ])
  const unknown = Object.keys(values)
    .filter(key => !accepted.has(key))
  const missing = [...required]
    .filter(key => values[key] === undefined)
  if (unknown.length > 0 || missing.length > 0) {
    throw new E3ValidationError(
      E3_VALIDATION_ERROR.INVALID_REQUEST,
      'Validation environment values do not match the allowlist',
      { unknown, missing }
    )
  }
  const environment = { ...FIXED_ENVIRONMENT }
  for (const [environmentKey, valueKey] of
    Object.entries(DYNAMIC_FIELDS)) {
    environment[environmentKey] = values[valueKey]
  }
  if (values.testOrigin !== undefined) {
    if (values.testOrigin !== E3_VALIDATION_UI_NETWORK.testOrigin) {
      throw new E3ValidationError(
        E3_VALIDATION_ERROR.UNSAFE_PROFILE,
        'UI validation origin is not the fixed internal origin'
      )
    }
    environment.E3_TEST_ORIGIN = values.testOrigin
  }
  return Object.freeze(environment)
}
