export const E3_VALIDATION_REQUEST_VERSION = 1
export const E3_VALIDATION_BROKER_FEATURE_FLAG =
  'E3_VALIDATION_BROKER_ENABLED'
export const E3_VALIDATION_PROFILE_SET_VERSION =
  'e3-validation-profiles-v1'
export const E3_VALIDATION_DRIVER =
  '/opt/echolink/validation-driver.mjs'
export const E3_VALIDATION_RUNTIME = Object.freeze({
  name: 'node',
  version: '24.18.0'
})

export const E3_VALIDATION_PROFILE_ID = Object.freeze({
  DIFF_CHECK: 'diff:check',
  SYNTAX_JAVASCRIPT: 'syntax:javascript',
  SYNTAX_JSON: 'syntax:json',
  TEST_TARGETED: 'test:targeted',
  TEST_FULL: 'test:full',
  BUILD_FRONTEND: 'build:frontend',
  SQLITE_INTEGRITY: 'sqlite:integrity',
  PLAYWRIGHT_UI: 'playwright:ui'
})

export const E3_VALIDATION_PROFILE_IDS = Object.freeze(
  Object.values(E3_VALIDATION_PROFILE_ID)
)

export const E3_VALIDATION_NETWORK_MODE = Object.freeze({
  NONE: 'none',
  INTERNAL_PAIR: 'internal_pair'
})

export const E3_VALIDATION_MOUNT = Object.freeze({
  SNAPSHOT: Object.freeze({
    target: '/e3/input',
    mode: 'read_only'
  }),
  OUTPUT: Object.freeze({
    target: '/e3/output',
    mode: 'bounded_read_write'
  }),
  TEMPORARY: Object.freeze({
    target: '/e3/tmp',
    mode: 'tmpfs'
  })
})

export const E3_VALIDATION_LIMITS = Object.freeze({
  maxRequestBytes: 16 * 1024,
  maxStdoutBytes: 10 * 1024 * 1024,
  maxStderrBytes: 10 * 1024 * 1024,
  maxOutputBytes: 64 * 1024 * 1024,
  maxPids: 128,
  maxOpenFiles: 1024
})

export function validationBrokerFeatureEnabled(env = {}) {
  return env[E3_VALIDATION_BROKER_FEATURE_FLAG] === 'true'
}
