import assert from 'node:assert/strict'
import test from 'node:test'
import {
  E3_VALIDATION_DRIVER,
  E3_VALIDATION_NETWORK_MODE,
  E3_VALIDATION_PROFILE_ID,
  E3_VALIDATION_RUNTIME
} from '../server/e3/validation/contracts.js'
import {
  E3_VALIDATION_ERROR,
  E3ValidationError
} from '../server/e3/validation/errors.js'
import {
  ValidationProfileRegistry
} from '../server/e3/validation/profileRegistry.js'
import {
  compileValidationPlan
} from '../server/e3/validation/validationPlanner.js'

const RUN_ID = '223e4567-e89b-42d3-a456-426614174000'
const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000'
const CANDIDATE_SET_ID =
  '323e4567-e89b-42d3-a456-426614174000'
const NODE_DIGEST = `sha256:${'a'.repeat(64)}`
const PLAYWRIGHT_DIGEST = `sha256:${'b'.repeat(64)}`

function registry() {
  return new ValidationProfileRegistry({
    nodeImageDigest: NODE_DIGEST,
    playwrightImageDigest: PLAYWRIGHT_DIGEST
  })
}

function request(profileRegistry, overrides = {}) {
  return {
    version: 1,
    runId: RUN_ID,
    sessionId: SESSION_ID,
    candidateSetId: CANDIDATE_SET_ID,
    candidateManifestSha256: 'c'.repeat(64),
    snapshotHandle: 'snapshot:immutable:001',
    profileId: E3_VALIDATION_PROFILE_ID.TEST_FULL,
    profileVersion: 1,
    profileSetSha256: profileRegistry.sha256,
    requestedAt: 4_000,
    leaseOwner: 'validation-broker-1',
    fencingToken: 7,
    ...overrides
  }
}

function compile(profileRegistry, value = request(profileRegistry)) {
  return compileValidationPlan(value, {
    registry: profileRegistry,
    actualRuntimeVersion: E3_VALIDATION_RUNTIME.version
  })
}

function validationCode(code) {
  return error =>
    error instanceof E3ValidationError &&
    error.code === code
}

test('profile registry is immutable, complete and digest-bound', () => {
  const first = registry()
  const second = registry()
  assert.equal(first.sha256, second.sha256)
  assert.equal(Object.keys(first.profiles).length, 8)
  assert.equal(
    first.profiles[E3_VALIDATION_PROFILE_ID.TEST_FULL]
      .imageDigest,
    NODE_DIGEST
  )
  assert.equal(
    first.profiles[E3_VALIDATION_PROFILE_ID.PLAYWRIGHT_UI]
      .imageDigest,
    PLAYWRIGHT_DIGEST
  )
  assert.equal(
    first.profiles[E3_VALIDATION_PROFILE_ID.PLAYWRIGHT_UI]
      .networkMode,
    E3_VALIDATION_NETWORK_MODE.INTERNAL_PAIR
  )
  assert.ok(Object.isFrozen(first))
  assert.ok(Object.isFrozen(first.profiles))
  assert.throws(() => {
    first.profiles[E3_VALIDATION_PROFILE_ID.TEST_FULL]
      .entrypoint.push('evil')
  }, TypeError)
})

test('invalid or mutable image references fail closed', () => {
  assert.throws(
    () => new ValidationProfileRegistry({
      nodeImageDigest: 'node:24',
      playwrightImageDigest: PLAYWRIGHT_DIGEST
    }),
    validationCode(E3_VALIDATION_ERROR.INVALID_IMAGE_DIGEST)
  )
  assert.throws(
    () => new ValidationProfileRegistry({
      nodeImageDigest: NODE_DIGEST,
      playwrightImageDigest: 'latest'
    }),
    validationCode(E3_VALIDATION_ERROR.INVALID_IMAGE_DIGEST)
  )
})

test('planner creates the same sealed plan for the same request', () => {
  const profileRegistry = registry()
  const first = compile(profileRegistry)
  const second = compile(profileRegistry)
  assert.deepEqual(second, first)
  assert.match(first.requestSha256, /^[0-9a-f]{64}$/)
  assert.match(first.planSha256, /^[0-9a-f]{64}$/)
  assert.equal(
    first.profile.entrypoint[1],
    E3_VALIDATION_DRIVER
  )
  assert.deepEqual(
    first.profile.entrypoint,
    [
      '/usr/bin/node',
      E3_VALIDATION_DRIVER,
      E3_VALIDATION_PROFILE_ID.TEST_FULL
    ]
  )
  assert.equal(first.isolation.hostNetwork, false)
  assert.equal(first.isolation.internetEgress, false)
  assert.equal(first.isolation.productionMounts, false)
  assert.equal(first.isolation.dockerSocket, false)
  assert.ok(Object.isFrozen(first))
  assert.ok(Object.isFrozen(first.isolation))
  assert.ok(Object.isFrozen(first.lease))
  assert.throws(() => {
    first.isolation.hostNetwork = true
  }, TypeError)
})

test('caller-controlled execution and isolation fields are rejected', () => {
  const profileRegistry = registry()
  for (const [field, value] of Object.entries({
    command: 'pm2 restart echolink',
    args: ['--privileged'],
    image: 'attacker/image:latest',
    mounts: ['/root/echolink:/workspace'],
    env: { OPENAI_API_KEY: 'sentinel' },
    networkMode: 'host',
    user: 'root',
    devices: ['/dev/kvm'],
    privileged: true
  })) {
    assert.throws(
      () => compile(profileRegistry, request(profileRegistry, {
        [field]: value
      })),
      validationCode(E3_VALIDATION_ERROR.INVALID_REQUEST),
      field
    )
  }
})

test('profile and profile-set drift are rejected', () => {
  const profileRegistry = registry()
  assert.throws(
    () => compile(profileRegistry, request(profileRegistry, {
      profileId: 'test:arbitrary'
    })),
    validationCode(E3_VALIDATION_ERROR.UNKNOWN_PROFILE)
  )
  assert.throws(
    () => compile(profileRegistry, request(profileRegistry, {
      profileVersion: 2
    })),
    validationCode(E3_VALIDATION_ERROR.PROFILE_VERSION_MISMATCH)
  )
  assert.throws(
    () => compile(profileRegistry, request(profileRegistry, {
      profileSetSha256: 'd'.repeat(64)
    })),
    validationCode(E3_VALIDATION_ERROR.PROFILE_SET_MISMATCH)
  )
})

test('runtime drift blocks plan compilation', () => {
  const profileRegistry = registry()
  assert.throws(
    () => compileValidationPlan(request(profileRegistry), {
      registry: profileRegistry,
      actualRuntimeVersion: '22.0.0'
    }),
    validationCode(E3_VALIDATION_ERROR.RUNTIME_VERSION_MISMATCH)
  )
})

test('environment is rebuilt from an exact allowlist', () => {
  const profileRegistry = registry()
  const sentinelKeys = [
    'OPENAI_API_KEY',
    'DATABASE_URL',
    'PM2_HOME',
    'GITHUB_TOKEN',
    'SSH_AUTH_SOCK'
  ]
  const previous = Object.fromEntries(
    sentinelKeys.map(key => [key, process.env[key]])
  )
  try {
    for (const key of sentinelKeys) {
      process.env[key] = `sentinel-${key}`
    }
    const plan = compile(profileRegistry)
    for (const key of sentinelKeys) {
      assert.equal(plan.environment[key], undefined)
    }
    assert.equal(plan.environment.HOME, '/e3/empty-home')
    assert.equal(plan.environment.NODE_ENV, 'test')
    assert.equal(plan.environment.E3_RUN_ID, RUN_ID)
    assert.equal(
      plan.environment.E3_CANDIDATE_MANIFEST_SHA256,
      'c'.repeat(64)
    )
    assert.equal(
      canonicalEnvironmentKeys(plan.environment),
      [
        'E3_CANDIDATE_MANIFEST_SHA256',
        'E3_PROFILE_ID',
        'E3_PROFILE_SHA256',
        'E3_RUN_ID',
        'E3_SESSION_ID',
        'E3_SNAPSHOT_HANDLE',
        'HOME',
        'LANG',
        'LC_ALL',
        'NODE_ENV',
        'PATH',
        'TMPDIR',
        'TZ'
      ].join(',')
    )
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

function canonicalEnvironmentKeys(environment) {
  return Object.keys(environment).sort().join(',')
}

test('invalid identifiers, hashes and fencing tokens are rejected', () => {
  const profileRegistry = registry()
  for (const overrides of [
    { runId: 'not-a-uuid' },
    { candidateSetId: SESSION_ID },
    { candidateManifestSha256: 'not-a-hash' },
    { snapshotHandle: '../production' },
    { fencingToken: 0 }
  ]) {
    const candidate = request(profileRegistry, overrides)
    assert.throws(() => compile(profileRegistry, candidate))
  }
})

test('profile digest changes alter profile-set and plan hashes', () => {
  const firstRegistry = registry()
  const secondRegistry = new ValidationProfileRegistry({
    nodeImageDigest: `sha256:${'e'.repeat(64)}`,
    playwrightImageDigest: PLAYWRIGHT_DIGEST
  })
  const first = compile(firstRegistry)
  const second = compile(
    secondRegistry,
    request(secondRegistry)
  )
  assert.notEqual(firstRegistry.sha256, secondRegistry.sha256)
  assert.notEqual(first.planSha256, second.planSha256)
})
