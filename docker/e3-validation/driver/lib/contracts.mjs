const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const TOKEN_PATTERN = /^[A-Za-z0-9._:-]+$/

export const INPUT_ROOT = '/e3/input'
export const OUTPUT_ROOT = '/e3/output'
export const TEMP_ROOT = '/e3/tmp'
export const WORK_ROOT = '/e3/tmp/work'
export const DEPENDENCY_ROOT = '/opt/echolink'
export const UI_FIXTURE_ROOT =
  'tests/fixtures/e3-validation-ui'

export const DRIVER_PROFILE = Object.freeze({
  DIFF_CHECK: 'diff:check',
  SYNTAX_JAVASCRIPT: 'syntax:javascript',
  SYNTAX_JSON: 'syntax:json',
  TEST_TARGETED: 'test:targeted',
  TEST_FULL: 'test:full',
  BUILD_FRONTEND: 'build:frontend',
  SQLITE_INTEGRITY: 'sqlite:integrity',
  PLAYWRIGHT_UI: 'playwright:ui',
  PLAYWRIGHT_APPLICATION: 'playwright:application'
})

export const DRIVER_PROFILES = Object.freeze(
  Object.values(DRIVER_PROFILE)
)

const REQUIRED_ENVIRONMENT = Object.freeze([
  'E3_RUN_ID',
  'E3_SESSION_ID',
  'E3_SNAPSHOT_HANDLE',
  'E3_CANDIDATE_MANIFEST_SHA256',
  'E3_PROFILE_ID',
  'E3_PROFILE_SHA256'
])

function invalid(message) {
  throw new Error(message)
}

export function validateDriverInvocation(profileId, env = process.env) {
  if (!DRIVER_PROFILES.includes(profileId)) {
    invalid('Unknown E3 validation driver profile')
  }
  for (const key of REQUIRED_ENVIRONMENT) {
    if (typeof env[key] !== 'string' || env[key].length === 0) {
      invalid(`Missing E3 validation environment field: ${key}`)
    }
  }
  if (!UUID_PATTERN.test(env.E3_RUN_ID)) {
    invalid('E3_RUN_ID is invalid')
  }
  if (!UUID_PATTERN.test(env.E3_SESSION_ID)) {
    invalid('E3_SESSION_ID is invalid')
  }
  if (!SHA256_PATTERN.test(env.E3_CANDIDATE_MANIFEST_SHA256)) {
    invalid('E3_CANDIDATE_MANIFEST_SHA256 is invalid')
  }
  if (!SHA256_PATTERN.test(env.E3_PROFILE_SHA256)) {
    invalid('E3_PROFILE_SHA256 is invalid')
  }
  if (
    !TOKEN_PATTERN.test(env.E3_SNAPSHOT_HANDLE) ||
    !TOKEN_PATTERN.test(env.E3_PROFILE_ID)
  ) {
    invalid('E3 validation token is invalid')
  }
  const expectedProfile = profileId === DRIVER_PROFILE.PLAYWRIGHT_APPLICATION
    ? DRIVER_PROFILE.PLAYWRIGHT_UI
    : profileId
  if (env.E3_PROFILE_ID !== expectedProfile) {
    invalid('E3 validation profile does not match the driver dispatch')
  }
  if (
    profileId === DRIVER_PROFILE.PLAYWRIGHT_UI ||
    profileId === DRIVER_PROFILE.PLAYWRIGHT_APPLICATION
  ) {
    if (env.E3_TEST_ORIGIN !== 'http://e3-app:4173') {
      invalid('E3_TEST_ORIGIN is not the fixed internal origin')
    }
  } else if (env.E3_TEST_ORIGIN !== undefined) {
    invalid('E3_TEST_ORIGIN is forbidden for this profile')
  }
  return Object.freeze({
    profileId,
    runId: env.E3_RUN_ID,
    sessionId: env.E3_SESSION_ID,
    snapshotHandle: env.E3_SNAPSHOT_HANDLE,
    candidateManifestSha256:
      env.E3_CANDIDATE_MANIFEST_SHA256,
    profileSha256: env.E3_PROFILE_SHA256,
    testOrigin: env.E3_TEST_ORIGIN
  })
}

export function childEnvironment(env = process.env) {
  const result = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TZ: 'UTC',
    NODE_ENV: 'test',
    HOME: '/e3/empty-home',
    TMPDIR: TEMP_ROOT
  }
  for (const key of REQUIRED_ENVIRONMENT) {
    result[key] = env[key]
  }
  if (env.E3_TEST_ORIGIN !== undefined) {
    result.E3_TEST_ORIGIN = env.E3_TEST_ORIGIN
  }
  if (env.PLAYWRIGHT_BROWSERS_PATH === '/ms-playwright') {
    result.PLAYWRIGHT_BROWSERS_PATH = '/ms-playwright'
  }
  return Object.freeze(result)
}
