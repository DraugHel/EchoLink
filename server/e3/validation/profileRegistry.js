import { createHash } from 'node:crypto'
import {
  E3_VALIDATION_DRIVER,
  E3_VALIDATION_LIMITS,
  E3_VALIDATION_MOUNT,
  E3_VALIDATION_NETWORK_MODE,
  E3_VALIDATION_PROFILE_ID,
  E3_VALIDATION_PROFILE_SET_VERSION,
  E3_VALIDATION_RUNTIME,
  E3_VALIDATION_UI_NETWORK
} from './contracts.js'
import {
  E3_VALIDATION_ERROR,
  E3ValidationError
} from './errors.js'

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, canonical(value[key])])
    )
  }
  return value
}

export function canonicalValidationJson(value) {
  return `${JSON.stringify(canonical(value), null, 2)}\n`
}

export function validationSha256(value) {
  return createHash('sha256').update(
    typeof value === 'string' || Buffer.isBuffer(value)
      ? value
      : canonicalValidationJson(value)
  ).digest('hex')
}

function validationError(code, message, details = {}) {
  throw new E3ValidationError(code, message, details)
}

function assertDigest(value, name) {
  if (!DIGEST_PATTERN.test(value)) {
    validationError(
      E3_VALIDATION_ERROR.INVALID_IMAGE_DIGEST,
      `${name} must be an immutable sha256 image digest`,
      { name }
    )
  }
  return value
}

function limits({
  timeoutMs,
  memoryBytes,
  cpuMillis,
  outputBytes = E3_VALIDATION_LIMITS.maxOutputBytes,
  pids = E3_VALIDATION_LIMITS.maxPids
}) {
  return Object.freeze({
    timeoutMs,
    memoryBytes,
    cpuMillis,
    pids,
    openFiles: E3_VALIDATION_LIMITS.maxOpenFiles,
    stdoutBytes: E3_VALIDATION_LIMITS.maxStdoutBytes,
    stderrBytes: E3_VALIDATION_LIMITS.maxStderrBytes,
    outputBytes
  })
}

function profile({
  id,
  imageDigest,
  networkMode = E3_VALIDATION_NETWORK_MODE.NONE,
  resourceLimits,
  role = 'validator',
  internalPair
}) {
  return Object.freeze({
    id,
    version: 1,
    role,
    runtime: E3_VALIDATION_RUNTIME,
    imageDigest,
    entrypoint: Object.freeze([
      '/usr/bin/node',
      E3_VALIDATION_DRIVER,
      id
    ]),
    mounts: Object.freeze([
      E3_VALIDATION_MOUNT.SNAPSHOT,
      E3_VALIDATION_MOUNT.OUTPUT,
      E3_VALIDATION_MOUNT.TEMPORARY
    ]),
    networkMode,
    ...(internalPair
      ? { internalPair: Object.freeze(internalPair) }
      : {}),
    user: Object.freeze({ uid: 65532, gid: 65532 }),
    rootFilesystem: 'read_only',
    capabilities: Object.freeze([]),
    noNewPrivileges: true,
    allowedExitCodes: Object.freeze([0]),
    limits: resourceLimits
  })
}

function buildProfiles(nodeImageDigest, playwrightImageDigest) {
  const node = assertDigest(nodeImageDigest, 'nodeImageDigest')
  const playwright = assertDigest(
    playwrightImageDigest,
    'playwrightImageDigest'
  )
  return [
    profile({
      id: E3_VALIDATION_PROFILE_ID.DIFF_CHECK,
      imageDigest: node,
      resourceLimits: limits({
        timeoutMs: 30_000,
        memoryBytes: 256 * 1024 * 1024,
        cpuMillis: 1_000
      })
    }),
    profile({
      id: E3_VALIDATION_PROFILE_ID.SYNTAX_JAVASCRIPT,
      imageDigest: node,
      resourceLimits: limits({
        timeoutMs: 60_000,
        memoryBytes: 512 * 1024 * 1024,
        cpuMillis: 2_000
      })
    }),
    profile({
      id: E3_VALIDATION_PROFILE_ID.SYNTAX_JSON,
      imageDigest: node,
      resourceLimits: limits({
        timeoutMs: 30_000,
        memoryBytes: 256 * 1024 * 1024,
        cpuMillis: 1_000
      })
    }),
    profile({
      id: E3_VALIDATION_PROFILE_ID.TEST_TARGETED,
      imageDigest: node,
      resourceLimits: limits({
        timeoutMs: 5 * 60_000,
        memoryBytes: 2 * 1024 * 1024 * 1024,
        cpuMillis: 4_000
      })
    }),
    profile({
      id: E3_VALIDATION_PROFILE_ID.TEST_FULL,
      imageDigest: node,
      resourceLimits: limits({
        timeoutMs: 10 * 60_000,
        memoryBytes: 3 * 1024 * 1024 * 1024,
        cpuMillis: 6_000
      })
    }),
    profile({
      id: E3_VALIDATION_PROFILE_ID.BUILD_FRONTEND,
      imageDigest: node,
      resourceLimits: limits({
        timeoutMs: 5 * 60_000,
        memoryBytes: 2 * 1024 * 1024 * 1024,
        cpuMillis: 4_000,
        outputBytes: 128 * 1024 * 1024
      })
    }),
    profile({
      id: E3_VALIDATION_PROFILE_ID.SQLITE_INTEGRITY,
      imageDigest: node,
      resourceLimits: limits({
        timeoutMs: 60_000,
        memoryBytes: 512 * 1024 * 1024,
        cpuMillis: 2_000
      })
    }),
    profile({
      id: E3_VALIDATION_PROFILE_ID.PLAYWRIGHT_UI,
      imageDigest: playwright,
      networkMode: E3_VALIDATION_NETWORK_MODE.INTERNAL_PAIR,
      role: 'browser',
      internalPair: {
        applicationAlias:
          E3_VALIDATION_UI_NETWORK.applicationAlias,
        applicationPort:
          E3_VALIDATION_UI_NETWORK.applicationPort,
        testOrigin: E3_VALIDATION_UI_NETWORK.testOrigin,
        application: Object.freeze({
          role: 'application',
          imageDigest: node,
          entrypoint: Object.freeze([
            '/usr/bin/node',
            E3_VALIDATION_DRIVER,
            'playwright:application'
          ]),
          mounts: Object.freeze([
            E3_VALIDATION_MOUNT.SNAPSHOT,
            E3_VALIDATION_MOUNT.TEMPORARY
          ]),
          user: Object.freeze({ uid: 65532, gid: 65532 }),
          rootFilesystem: 'read_only',
          capabilities: Object.freeze([]),
          noNewPrivileges: true,
          limits: limits({
            timeoutMs: 10 * 60_000,
            memoryBytes: 2 * 1024 * 1024 * 1024,
            cpuMillis: 4_000,
            outputBytes: 64 * 1024 * 1024,
            pids: 192
          })
        })
      },
      resourceLimits: limits({
        timeoutMs: 10 * 60_000,
        memoryBytes: 3 * 1024 * 1024 * 1024,
        cpuMillis: 6_000,
        outputBytes: 256 * 1024 * 1024,
        pids: 256
      })
    })
  ]
}

function assertProfileSafety(profileDefinition) {
  const serialized = canonicalValidationJson(profileDefinition)
  const forbidden = [
    '/root/echolink',
    '/var/run/docker.sock',
    'hostnetwork',
    'host',
    'privileged'
  ]
  if (
    profileDefinition.capabilities.length !== 0 ||
    profileDefinition.rootFilesystem !== 'read_only' ||
    profileDefinition.noNewPrivileges !== true ||
    forbidden.some(value => serialized.includes(value))
  ) {
    validationError(
      E3_VALIDATION_ERROR.UNSAFE_PROFILE,
      'Validation profile violates the E3 sandbox baseline',
      { profileId: profileDefinition.id }
    )
  }
  if (
    profileDefinition.networkMode ===
      E3_VALIDATION_NETWORK_MODE.INTERNAL_PAIR &&
    (
      profileDefinition.internalPair?.applicationAlias !==
        E3_VALIDATION_UI_NETWORK.applicationAlias ||
      profileDefinition.internalPair?.applicationPort !==
        E3_VALIDATION_UI_NETWORK.applicationPort ||
      profileDefinition.internalPair?.testOrigin !==
        E3_VALIDATION_UI_NETWORK.testOrigin ||
      profileDefinition.internalPair?.application?.role !==
        'application' ||
      profileDefinition.internalPair?.application?.rootFilesystem !==
        'read_only' ||
      profileDefinition.internalPair?.application?.capabilities?.length !==
        0 ||
      profileDefinition.internalPair?.application?.noNewPrivileges !==
        true ||
      profileDefinition.internalPair?.application?.user?.uid === 0 ||
      profileDefinition.internalPair?.application?.user?.gid === 0
    )
  ) {
    validationError(
      E3_VALIDATION_ERROR.UNSAFE_PROFILE,
      'UI validation profile violates the internal-pair contract',
      { profileId: profileDefinition.id }
    )
  }
}

export class ValidationProfileRegistry {
  constructor({ nodeImageDigest, playwrightImageDigest }) {
    const profiles = buildProfiles(
      nodeImageDigest,
      playwrightImageDigest
    )
    for (const definition of profiles) {
      assertProfileSafety(definition)
    }
    this.version = E3_VALIDATION_PROFILE_SET_VERSION
    this.profiles = Object.freeze(Object.fromEntries(
      profiles.map(definition => [
        definition.id,
        Object.freeze({
          ...definition,
          sha256: validationSha256(definition)
        })
      ])
    ))
    this.sha256 = validationSha256({
      version: this.version,
      profiles: this.profiles
    })
    Object.freeze(this)
  }

  get(profileId, profileVersion) {
    const definition = this.profiles[profileId]
    if (!definition) {
      validationError(
        E3_VALIDATION_ERROR.UNKNOWN_PROFILE,
        'Validation profile is not registered',
        { profileId }
      )
    }
    if (profileVersion !== definition.version) {
      validationError(
        E3_VALIDATION_ERROR.PROFILE_VERSION_MISMATCH,
        'Validation profile version does not match',
        {
          profileId,
          expectedVersion: definition.version,
          actualVersion: profileVersion
        }
      )
    }
    return definition
  }
}
