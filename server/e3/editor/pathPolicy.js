import { Buffer } from 'node:buffer'
import {
  E3_EDITOR_LIMITS,
  E3_PATH_POLICY_VERSION
} from './contracts.js'
import {
  E3_EDITOR_ERROR,
  E3EditorError
} from './errors.js'

const PORTABLE_SEGMENT = /^[A-Za-z0-9._-]+$/
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/
const FORBIDDEN_ROOTS = new Set([
  'data',
  'backups',
  'uploads',
  'node_modules',
  'dist',
  'coverage',
  '.cache',
  'cache',
  'runtime',
  'locks',
  'quarantine',
  'artifacts'
])
const DATABASE_SUFFIXES = Object.freeze([
  '.db',
  '.db-journal',
  '.db-shm',
  '.db-wal',
  '.sqlite',
  '.sqlite3'
])

function pathError(code, message, details = {}) {
  throw new E3EditorError(code, message, {
    policyVersion: E3_PATH_POLICY_VERSION,
    ...details
  })
}

function isForbiddenEnvironmentFile(name) {
  if (name === '.env.example') return false
  return name === '.env' || name.startsWith('.env.')
}

function isForbiddenDatabaseFile(name) {
  return DATABASE_SUFFIXES.some(suffix => name.endsWith(suffix))
}

export function assertEditorPath(relativePath, {
  mutation = false
} = {}) {
  if (
    typeof relativePath !== 'string' ||
    relativePath.length === 0
  ) {
    pathError(
      E3_EDITOR_ERROR.INVALID_PATH,
      'Editor path must be a non-empty string'
    )
  }
  if (
    relativePath.startsWith('/') ||
    relativePath.includes('\\') ||
    relativePath.endsWith('/') ||
    relativePath.includes('//') ||
    CONTROL_CHARACTERS.test(relativePath) ||
    relativePath.normalize('NFC') !== relativePath
  ) {
    pathError(
      E3_EDITOR_ERROR.INVALID_PATH,
      'Editor path is not canonical POSIX text'
    )
  }
  if (
    Buffer.byteLength(relativePath, 'utf8') >
    E3_EDITOR_LIMITS.maxPathBytes
  ) {
    pathError(
      E3_EDITOR_ERROR.INVALID_PATH,
      'Editor path exceeds the V1 byte limit'
    )
  }

  const segments = relativePath.split('/')
  for (const segment of segments) {
    if (
      segment === '' ||
      segment === '.' ||
      segment === '..' ||
      !PORTABLE_SEGMENT.test(segment) ||
      Buffer.byteLength(segment, 'utf8') >
        E3_EDITOR_LIMITS.maxSegmentBytes
    ) {
      pathError(
        E3_EDITOR_ERROR.INVALID_PATH,
        'Editor path contains a non-portable segment'
      )
    }
  }

  const lowerSegments = segments.map(segment =>
    segment.toLowerCase()
  )
  const basename = lowerSegments.at(-1)
  if (
    lowerSegments.includes('.git') ||
    FORBIDDEN_ROOTS.has(lowerSegments[0]) ||
    lowerSegments.some(segment => segment === 'node_modules') ||
    isForbiddenEnvironmentFile(basename) ||
    isForbiddenDatabaseFile(basename)
  ) {
    pathError(
      E3_EDITOR_ERROR.FORBIDDEN_PATH,
      mutation
        ? 'Mutation target is forbidden by policy'
        : 'Read target is forbidden by policy',
      { relativePath }
    )
  }

  return Object.freeze({
    relativePath,
    segments: Object.freeze(segments),
    mutation,
    policyVersion: E3_PATH_POLICY_VERSION
  })
}

export function pathPolicyAllowsInventoryName(name) {
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    CONTROL_CHARACTERS.test(name)
  ) {
    return false
  }
  return true
}
