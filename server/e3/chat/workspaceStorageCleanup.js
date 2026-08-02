import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync
} from 'node:fs'
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from 'node:path'

const TERMINAL_WORKSPACE_STATE = 'REMOVED'
const ALLOWED_LAYOUT_ENTRIES = Object.freeze([
  'artifacts',
  'locks',
  'quarantine',
  'repo.git',
  'runtime',
  'workspaces'
])
const EMPTY_LAYOUT_DIRECTORIES = Object.freeze([
  'artifacts',
  'locks',
  'quarantine',
  'runtime',
  'workspaces'
])

export class E3WorkspaceStorageCleanupError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'E3WorkspaceStorageCleanupError'
    this.code = 'E3_CHAT_WORKSPACE_STORAGE_UNSAFE'
    this.details = Object.freeze({ ...details })
  }
}

function fail(message, details = {}) {
  throw new E3WorkspaceStorageCleanupError(
    message,
    details
  )
}

function isContained(root, candidate) {
  const parent = resolve(root)
  const child = resolve(candidate)
  const relation = relative(parent, child)
  return (
    relation !== '' &&
    relation !== '..' &&
    !relation.startsWith(`..${sep}`) &&
    !isAbsolute(relation)
  )
}

function assertRealDirectory(path, expectedUid) {
  const metadata = lstatSync(path)
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== expectedUid ||
    realpathSync(path) !== resolve(path)
  ) {
    fail('Workspace storage directory identity is unsafe', {
      path
    })
  }
  return metadata
}

function assertEmptyDirectory(path, expectedUid) {
  assertRealDirectory(path, expectedUid)
  if (readdirSync(path).length !== 0) {
    fail('Workspace storage directory is not empty', {
      path
    })
  }
}

function logicalBytes(path) {
  const metadata = lstatSync(path)
  if (metadata.isDirectory()) {
    return readdirSync(path)
      .reduce(
        (total, name) =>
          total + logicalBytes(join(path, name)),
        metadata.size
      )
  }
  return metadata.size
}

function removeVerifiedTree(root, expectedUid) {
  const visit = current => {
    assertRealDirectory(current, expectedUid)
    const entries = readdirSync(current, {
      withFileTypes: true
    })

    for (const entry of entries) {
      const target = join(current, entry.name)
      if (!isContained(root, target)) {
        fail('Workspace cleanup path escaped its root', {
          root,
          target
        })
      }

      const metadata = lstatSync(target)
      if (
        metadata.isSymbolicLink() ||
        metadata.uid !== expectedUid
      ) {
        fail('Workspace cleanup entry identity is unsafe', {
          target
        })
      }

      if (metadata.isDirectory()) {
        if (realpathSync(target) !== resolve(target)) {
          fail('Workspace cleanup directory is not canonical', {
            target
          })
        }
        visit(target)
        rmdirSync(target)
        continue
      }

      if (!metadata.isFile()) {
        fail('Workspace cleanup entry type is unsupported', {
          target
        })
      }

      unlinkSync(target)
    }
  }

  visit(root)
  rmdirSync(root)
}

export function cleanupTerminalWorkspaceStorage({
  database,
  sessionId,
  sessionRoot,
  workspaceStorageRoot,
  expectedUid = process.getuid?.(),
  dryRun = false
}) {
  if (
    !database ||
    typeof database.prepare !== 'function' ||
    typeof sessionId !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(sessionId) ||
    !Number.isSafeInteger(expectedUid) ||
    expectedUid < 0 ||
    typeof dryRun !== 'boolean'
  ) {
    fail('Workspace storage cleanup arguments are invalid')
  }

  const canonicalSessionRoot = resolve(sessionRoot)
  const canonicalStorageRoot = resolve(workspaceStorageRoot)

  if (
    canonicalStorageRoot !==
      join(canonicalSessionRoot, 'workspace-storage') ||
    !isContained(canonicalSessionRoot, canonicalStorageRoot)
  ) {
    fail('Workspace storage root is not session-local', {
      sessionRoot: canonicalSessionRoot,
      workspaceStorageRoot: canonicalStorageRoot
    })
  }

  if (!existsSync(canonicalStorageRoot)) {
    return Object.freeze({
      removed: false,
      alreadyAbsent: true,
      logicalBytes: 0
    })
  }

  assertRealDirectory(canonicalSessionRoot, expectedUid)
  assertRealDirectory(canonicalStorageRoot, expectedUid)

  const workspace = database.prepare(`
    SELECT state
    FROM editor_workspaces
    WHERE session_id = ?
  `).get(sessionId)

  if (
    !workspace ||
    workspace.state !== TERMINAL_WORKSPACE_STATE
  ) {
    fail('Workspace database record is not safely removed', {
      sessionId,
      state: workspace?.state ?? null
    })
  }

  const actualEntries = readdirSync(canonicalStorageRoot)
    .sort()

  if (
    actualEntries.length !== ALLOWED_LAYOUT_ENTRIES.length ||
    actualEntries.some(
      (name, index) =>
        name !== ALLOWED_LAYOUT_ENTRIES[index]
    )
  ) {
    fail('Workspace storage layout contains unknown entries', {
      actualEntries
    })
  }

  for (const name of EMPTY_LAYOUT_DIRECTORIES) {
    assertEmptyDirectory(
      join(canonicalStorageRoot, name),
      expectedUid
    )
  }

  const mirror = join(canonicalStorageRoot, 'repo.git')
  assertRealDirectory(mirror, expectedUid)

  const worktreeMetadata = join(mirror, 'worktrees')
  if (
    existsSync(worktreeMetadata) &&
    readdirSync(worktreeMetadata).length !== 0
  ) {
    fail('Bare mirror still registers linked worktrees', {
      path: worktreeMetadata
    })
  }

  const bytes = logicalBytes(canonicalStorageRoot)

  if (dryRun) {
    return Object.freeze({
      removed: false,
      alreadyAbsent: false,
      wouldRemove: true,
      logicalBytes: bytes
    })
  }

  removeVerifiedTree(canonicalStorageRoot, expectedUid)

  const parentDescriptor = openSync(
    dirname(canonicalStorageRoot),
    'r'
  )
  try {
    fsyncSync(parentDescriptor)
  } finally {
    closeSync(parentDescriptor)
  }

  return Object.freeze({
    removed: true,
    alreadyAbsent: false,
    logicalBytes: bytes
  })
}
