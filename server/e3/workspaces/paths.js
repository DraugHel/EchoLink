import {
  lstatSync,
  mkdirSync,
  realpathSync
} from 'node:fs'
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from 'node:path'
import {
  assertCanonicalSessionId
} from '../core/contracts.js'
import {
  E3_WORKSPACE_ERROR,
  E3WorkspaceError
} from './errors.js'

function workspaceError(code, message, details = {}) {
  throw new E3WorkspaceError(code, message, details)
}

function pathsOverlap(first, second) {
  const firstToSecond = relative(first, second)
  const secondToFirst = relative(second, first)
  return (
    first === second ||
    (
      firstToSecond !== '..' &&
      !firstToSecond.startsWith(`..${sep}`)
    ) ||
    (
      secondToFirst !== '..' &&
      !secondToFirst.startsWith(`..${sep}`)
    )
  )
}

export function assertContainedPath(rootPath, candidatePath) {
  const canonicalRoot = resolve(rootPath)
  const canonicalCandidate = resolve(candidatePath)
  const relation = relative(canonicalRoot, canonicalCandidate)

  if (
    relation === '' ||
    relation === '..' ||
    relation.startsWith('../') ||
    isAbsolute(relation)
  ) {
    workspaceError(
      E3_WORKSPACE_ERROR.UNSAFE_PATH,
      'Workspace path is not a contained child',
      { rootPath: canonicalRoot }
    )
  }
  return canonicalCandidate
}

function ensureCanonicalDirectory(path, mode) {
  mkdirSync(path, { recursive: true, mode })
  const metadata = lstatSync(path)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    workspaceError(
      E3_WORKSPACE_ERROR.PATH_TAMPERED,
      'Manager directory is not a real directory'
    )
  }
  const canonical = realpathSync(path)
  if (canonical !== resolve(path)) {
    workspaceError(
      E3_WORKSPACE_ERROR.PATH_TAMPERED,
      'Manager directory traverses a symbolic link'
    )
  }
  return canonical
}

export function prepareWorkspaceLayout({
  storageRoot,
  sourceRepositoryPath,
  forbiddenRoots = [
    '/root/echolink',
    '/root/echolink-backups',
    '/root/echolink-patch-backups'
  ]
}) {
  if (
    typeof storageRoot !== 'string' ||
    !isAbsolute(storageRoot) ||
    resolve(storageRoot) === '/'
  ) {
    workspaceError(
      E3_WORKSPACE_ERROR.INVALID_CONFIGURATION,
      'Workspace storage root must be an absolute non-root path'
    )
  }
  if (
    typeof sourceRepositoryPath !== 'string' ||
    !isAbsolute(sourceRepositoryPath)
  ) {
    workspaceError(
      E3_WORKSPACE_ERROR.INVALID_CONFIGURATION,
      'Source repository path must be absolute'
    )
  }

  const sourcePath = realpathSync(sourceRepositoryPath)
  const requestedRoot = resolve(storageRoot)

  if (pathsOverlap(requestedRoot, sourcePath)) {
    workspaceError(
      E3_WORKSPACE_ERROR.UNSAFE_SOURCE_REPOSITORY,
      'Workspace storage and source repository overlap'
    )
  }

  for (const forbiddenRoot of forbiddenRoots) {
    if (
      typeof forbiddenRoot !== 'string' ||
      !isAbsolute(forbiddenRoot)
    ) {
      workspaceError(
        E3_WORKSPACE_ERROR.INVALID_CONFIGURATION,
        'Forbidden roots must be absolute'
      )
    }
    if (pathsOverlap(requestedRoot, resolve(forbiddenRoot))) {
      workspaceError(
        E3_WORKSPACE_ERROR.UNSAFE_STORAGE_ROOT,
        'Workspace storage overlaps a forbidden root'
      )
    }
  }

  const root = ensureCanonicalDirectory(requestedRoot, 0o750)

  const layout = {
    root,
    sourceRepositoryPath: sourcePath,
    mirrorPath: join(root, 'repo.git'),
    workspacesPath: ensureCanonicalDirectory(
      join(root, 'workspaces'),
      0o750
    ),
    artifactsPath: ensureCanonicalDirectory(
      join(root, 'artifacts'),
      0o750
    ),
    runtimePath: ensureCanonicalDirectory(
      join(root, 'runtime'),
      0o750
    ),
    locksPath: ensureCanonicalDirectory(
      join(root, 'locks'),
      0o750
    ),
    quarantinePath: ensureCanonicalDirectory(
      join(root, 'quarantine'),
      0o750
    )
  }

  return Object.freeze(layout)
}

export function workspacePaths(layout, sessionId) {
  assertCanonicalSessionId(sessionId)
  const workspaceRoot = assertContainedPath(
    layout.workspacesPath,
    join(layout.workspacesPath, sessionId)
  )
  const treePath = assertContainedPath(
    workspaceRoot,
    join(workspaceRoot, 'tree')
  )
  const manifestPath = assertContainedPath(
    workspaceRoot,
    join(workspaceRoot, 'manifest.json')
  )
  const workspaceLockPath = assertContainedPath(
    layout.locksPath,
    join(layout.locksPath, `workspace-${sessionId}.lock`)
  )

  return Object.freeze({
    workspaceKey: `workspace-${sessionId}`,
    workspaceRoot,
    treePath,
    manifestPath,
    workspaceLockPath
  })
}
