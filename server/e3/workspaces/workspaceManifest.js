import { createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname } from 'node:path'
import {
  E3_WORKSPACE_ERROR,
  E3WorkspaceError
} from './errors.js'

function manifestError(message) {
  throw new E3WorkspaceError(
    E3_WORKSPACE_ERROR.MANIFEST_MISMATCH,
    message
  )
}

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, normalize(value[key])])
    )
  }
  return value
}

export function serializeWorkspaceManifest(manifest) {
  return `${JSON.stringify(normalize(manifest), null, 2)}\n`
}

export function workspaceManifestSha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function publishWorkspaceManifest(manifestPath, manifest) {
  const bytes = serializeWorkspaceManifest(manifest)
  const temporaryPath = `${manifestPath}.stage-${process.pid}`
  let descriptor

  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600)
    writeFileSync(descriptor, bytes, { encoding: 'utf8' })
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    chmodSync(temporaryPath, 0o600)
    renameSync(temporaryPath, manifestPath)

    const parent = openSync(dirname(manifestPath), 'r')
    try {
      fsyncSync(parent)
    } finally {
      closeSync(parent)
    }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    try {
      unlinkSync(temporaryPath)
    } catch {}
    throw error
  }

  return Object.freeze({
    bytes,
    sha256: workspaceManifestSha256(bytes)
  })
}

export function readVerifiedWorkspaceManifest(
  manifestPath,
  expectedSha256
) {
  const metadata = lstatSync(manifestPath)
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    manifestError('Workspace manifest is not a regular file')
  }
  const bytes = readFileSync(manifestPath, 'utf8')
  const actualSha256 = workspaceManifestSha256(bytes)
  if (actualSha256 !== expectedSha256) {
    manifestError('Workspace manifest hash changed')
  }

  let manifest
  try {
    manifest = JSON.parse(bytes)
  } catch {
    manifestError('Workspace manifest is not valid JSON')
  }

  return Object.freeze({
    manifest: Object.freeze(manifest),
    sha256: actualSha256
  })
}
