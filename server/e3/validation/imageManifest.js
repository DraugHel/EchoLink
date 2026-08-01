import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  E3_NODE_VALIDATION_BASE,
  E3_PLAYWRIGHT_VALIDATION_BASE,
  E3_VALIDATION_IMAGE_SOURCE_VERSION
} from './imageSources.js'
import {
  E3_VALIDATION_ERROR,
  E3ValidationError
} from './errors.js'
import {
  canonicalValidationJson,
  validationSha256
} from './profileRegistry.js'

export const DEFAULT_E3_VALIDATION_IMAGE_MANIFEST =
  '/var/lib/echolink-e3/validation-images.json'

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/
const TREE_PATTERN = /^[0-9a-f]{40}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const TAG_PATTERN = /^[a-z0-9][a-z0-9._/-]*:[a-z0-9][a-z0-9._-]*$/

const MANIFEST_FIELDS = Object.freeze([
  'version',
  'builtAt',
  'sourceHead',
  'sourceTreeGitSha',
  'sourceTreeSha256',
  'runtimeVersion',
  'architecture',
  'nodeBaseReference',
  'playwrightBaseReference',
  'playwrightVersion',
  'rootLockSha256',
  'clientLockSha256',
  'driverLockSha256',
  'driverSourceSha256',
  'nodeImageDigest',
  'playwrightImageDigest',
  'nodeImageTag',
  'playwrightImageTag',
  'manifestSha256'
])

function manifestError(message, details = {}, cause) {
  throw new E3ValidationError(
    E3_VALIDATION_ERROR.INVALID_IMAGE_MANIFEST,
    message,
    details,
    cause ? { cause } : {}
  )
}

function exactFields(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    manifestError('Validation image manifest must be an object')
  }
  const actual = Object.keys(value).sort()
  const expected = [...MANIFEST_FIELDS].sort()
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    manifestError(
      'Validation image manifest fields do not match the V1 contract',
      { actual, expected }
    )
  }
}

function assertPattern(value, pattern, field) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    manifestError(
      `Validation image manifest has invalid ${field}`,
      { field }
    )
  }
  return value
}

function unsignedManifest(manifest) {
  const { manifestSha256, ...unsigned } = manifest
  return unsigned
}

export function validationDriverSourceSha256(rootDirectory) {
  const root = path.resolve(rootDirectory)
  const driverRoot = path.join(root, 'docker/e3-validation/driver')
  const files = []
  const visit = current => {
    for (const name of fs.readdirSync(current).sort()) {
      const absolute = path.join(current, name)
      const stat = fs.lstatSync(absolute)
      if (
        stat.isSymbolicLink() ||
        (!stat.isFile() && !stat.isDirectory())
      ) {
        manifestError('Validation driver contains an unsupported entry')
      }
      if (stat.isDirectory()) visit(absolute)
      else files.push(absolute)
    }
  }
  visit(driverRoot)
  const hash = createHash('sha256')
  for (const absolute of files) {
    const relative = path.relative(root, absolute).split(path.sep).join('/')
    const bytes = fs.readFileSync(absolute)
    hash.update(relative)
    hash.update('\0')
    hash.update(String(bytes.length))
    hash.update('\0')
    hash.update(bytes)
    hash.update('\0')
  }
  return hash.digest('hex')
}

export function createValidationImageManifest(input) {
  const unsigned = {
    version: E3_VALIDATION_IMAGE_SOURCE_VERSION,
    builtAt: input.builtAt,
    sourceHead: input.sourceHead,
    sourceTreeGitSha: input.sourceTreeGitSha,
    sourceTreeSha256: input.sourceTreeSha256,
    runtimeVersion: E3_NODE_VALIDATION_BASE.runtimeVersion,
    architecture: E3_NODE_VALIDATION_BASE.architecture,
    nodeBaseReference: E3_NODE_VALIDATION_BASE.reference,
    playwrightBaseReference:
      E3_PLAYWRIGHT_VALIDATION_BASE.reference,
    playwrightVersion:
      E3_PLAYWRIGHT_VALIDATION_BASE.playwrightVersion,
    rootLockSha256: input.rootLockSha256,
    clientLockSha256: input.clientLockSha256,
    driverLockSha256: input.driverLockSha256,
    driverSourceSha256: input.driverSourceSha256,
    nodeImageDigest: input.nodeImageDigest,
    playwrightImageDigest: input.playwrightImageDigest,
    nodeImageTag: input.nodeImageTag,
    playwrightImageTag: input.playwrightImageTag
  }
  return Object.freeze({
    ...unsigned,
    manifestSha256: validationSha256(unsigned)
  })
}

export function parseValidationImageManifest(bytes, {
  expectedSourceTreeGitSha,
  expectedSourceTreeSha256,
  expectedRootLockSha256,
  expectedClientLockSha256,
  expectedDriverLockSha256,
  expectedDriverSourceSha256
} = {}) {
  let manifest
  try {
    manifest = JSON.parse(String(bytes))
  } catch (cause) {
    manifestError('Validation image manifest is not valid JSON', {}, cause)
  }
  exactFields(manifest)
  if (manifest.version !== E3_VALIDATION_IMAGE_SOURCE_VERSION) {
    manifestError('Validation image manifest version is unsupported')
  }
  if (
    !Number.isSafeInteger(manifest.builtAt) ||
    manifest.builtAt < 0
  ) {
    manifestError('Validation image manifest builtAt is invalid')
  }
  assertPattern(manifest.sourceHead, TREE_PATTERN, 'sourceHead')
  assertPattern(
    manifest.sourceTreeGitSha,
    TREE_PATTERN,
    'sourceTreeGitSha'
  )
  assertPattern(
    manifest.sourceTreeSha256,
    SHA256_PATTERN,
    'sourceTreeSha256'
  )
  for (const field of [
    'rootLockSha256',
    'clientLockSha256',
    'driverLockSha256',
    'driverSourceSha256',
    'manifestSha256'
  ]) {
    assertPattern(manifest[field], SHA256_PATTERN, field)
  }
  for (const field of [
    'nodeImageDigest',
    'playwrightImageDigest'
  ]) {
    assertPattern(manifest[field], DIGEST_PATTERN, field)
  }
  for (const field of ['nodeImageTag', 'playwrightImageTag']) {
    assertPattern(manifest[field], TAG_PATTERN, field)
  }
  if (
    manifest.runtimeVersion !== E3_NODE_VALIDATION_BASE.runtimeVersion ||
    manifest.architecture !== E3_NODE_VALIDATION_BASE.architecture ||
    manifest.nodeBaseReference !== E3_NODE_VALIDATION_BASE.reference ||
    manifest.playwrightBaseReference !==
      E3_PLAYWRIGHT_VALIDATION_BASE.reference ||
    manifest.playwrightVersion !==
      E3_PLAYWRIGHT_VALIDATION_BASE.playwrightVersion
  ) {
    manifestError('Validation image manifest source policy does not match')
  }
  const actualManifestSha256 = validationSha256(
    unsignedManifest(manifest)
  )
  if (actualManifestSha256 !== manifest.manifestSha256) {
    manifestError('Validation image manifest hash does not match')
  }
  const expectations = {
    sourceTreeGitSha: expectedSourceTreeGitSha,
    sourceTreeSha256: expectedSourceTreeSha256,
    rootLockSha256: expectedRootLockSha256,
    clientLockSha256: expectedClientLockSha256,
    driverLockSha256: expectedDriverLockSha256,
    driverSourceSha256: expectedDriverSourceSha256
  }
  for (const [field, expected] of Object.entries(expectations)) {
    if (expected !== undefined && manifest[field] !== expected) {
      manifestError(
        `Validation image manifest does not match ${field}`,
        { field }
      )
    }
  }
  return Object.freeze({ ...manifest })
}

export function loadValidationImageManifest({
  manifestPath = DEFAULT_E3_VALIDATION_IMAGE_MANIFEST,
  ...expectations
} = {}) {
  const resolved = path.resolve(manifestPath)
  if (!path.isAbsolute(manifestPath) || resolved !== manifestPath) {
    manifestError('Validation image manifest path must be canonical')
  }
  let actual
  let bytes
  let stat
  try {
    actual = fs.realpathSync.native(resolved)
    stat = fs.lstatSync(resolved)
    bytes = fs.readFileSync(resolved)
  } catch (cause) {
    manifestError('Validation image manifest is unavailable', {}, cause)
  }
  if (
    actual !== resolved ||
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.uid !== 0 ||
    (stat.mode & 0o777) !== 0o640 ||
    stat.size > 64 * 1024
  ) {
    manifestError('Validation image manifest file is unsafe')
  }
  return parseValidationImageManifest(bytes, expectations)
}

export function serializeValidationImageManifest(manifest) {
  parseValidationImageManifest(canonicalValidationJson(manifest))
  return canonicalValidationJson(manifest)
}
