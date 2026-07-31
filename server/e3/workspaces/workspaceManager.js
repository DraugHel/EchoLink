import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync
} from 'node:fs'
import { join, resolve } from 'node:path'
import {
  E3_SESSION_STATUS,
  assertCanonicalSessionId,
  assertFencingToken,
  assertSafeToken,
  assertTimestamp,
  freezeDomainValue
} from '../core/contracts.js'
import {
  E3_WORKSPACE_MANIFEST_VERSION,
  E3_WORKSPACE_STATE
} from './contracts.js'
import {
  E3_WORKSPACE_ERROR,
  E3WorkspaceError
} from './errors.js'
import { acquireManagerLock } from './managerLock.js'
import {
  prepareWorkspaceLayout,
  workspacePaths
} from './paths.js'
import {
  publishWorkspaceManifest,
  readVerifiedWorkspaceManifest
} from './workspaceManifest.js'
import { WorkspaceGit } from './workspaceGit.js'
import {
  WorkspaceRepository
} from './workspaceRepository.js'
import { scanWorkspaceTree } from './treeScanner.js'

function workspaceError(code, message, details = {}, cause) {
  throw new E3WorkspaceError(
    code,
    message,
    details,
    cause ? { cause } : {}
  )
}

function assertRealDirectory(path, errorCode) {
  const metadata = lstatSync(path)
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    realpathSync(path) !== resolve(path)
  ) {
    workspaceError(
      errorCode,
      'Workspace directory identity is unsafe'
    )
  }
}

function assertManifestBinding(
  manifest,
  record,
  paths
) {
  const expected = {
    schemaVersion: E3_WORKSPACE_MANIFEST_VERSION,
    sessionId: record.sessionId,
    workspaceKey: record.workspaceKey,
    baseCommit: record.baseCommit,
    treeSha: record.treeSha,
    canonicalWorkspacePath: record.canonicalPath,
    managerOwner: record.managerOwner,
    createdAt: record.createdAt,
    fencingToken: record.fencingToken
  }

  for (const [field, value] of Object.entries(expected)) {
    if (manifest[field] !== value) {
      workspaceError(
        E3_WORKSPACE_ERROR.MANIFEST_MISMATCH,
        `Workspace manifest does not match ${field}`
      )
    }
  }
  if (
    manifest.expectedSubpaths?.length !== 2 ||
    manifest.expectedSubpaths[0] !== 'tree' ||
    manifest.expectedSubpaths[1] !== 'manifest.json' ||
    manifest.allowedRoots?.length !== 1 ||
    manifest.allowedRoots[0] !== paths.treePath
  ) {
    workspaceError(
      E3_WORKSPACE_ERROR.MANIFEST_MISMATCH,
      'Workspace manifest path policy changed'
    )
  }
}

export class WorkspaceManager {
  constructor({
    database,
    storageRoot,
    sourceRepositoryPath,
    managerOwner,
    enabled = false,
    forbiddenRoots
  }) {
    if (!database) {
      workspaceError(
        E3_WORKSPACE_ERROR.INVALID_CONFIGURATION,
        'Workspace manager requires editor.db'
      )
    }
    assertSafeToken(managerOwner, 'managerOwner')
    this.repository = new WorkspaceRepository(database)
    this.storageRoot = storageRoot
    this.sourceRepositoryPath = sourceRepositoryPath
    this.managerOwner = managerOwner
    this.enabled = enabled === true
    this.forbiddenRoots = forbiddenRoots
    this.layout = null
    this.git = null
  }

  prepareStorage() {
    this.#assertEnabled()
    const verifiedLayout = prepareWorkspaceLayout({
      storageRoot: this.storageRoot,
      sourceRepositoryPath: this.sourceRepositoryPath,
      forbiddenRoots: this.forbiddenRoots
    })
    if (!this.layout) {
      this.layout = verifiedLayout
      this.git = new WorkspaceGit({
        mirrorPath: this.layout.mirrorPath,
        sourceRepositoryPath:
          this.layout.sourceRepositoryPath,
        runtimeHome: this.layout.runtimePath
      })
    } else {
      for (const [field, value] of Object.entries(this.layout)) {
        if (verifiedLayout[field] !== value) {
          workspaceError(
            E3_WORKSPACE_ERROR.PATH_TAMPERED,
            `Workspace layout identity changed at ${field}`
          )
        }
      }
    }
    return this.layout
  }

  provisionWorkspace({
    sessionId,
    leaseOwner,
    fencingToken,
    createdAt
  }) {
    this.#assertEnabled()
    assertCanonicalSessionId(sessionId)
    assertSafeToken(leaseOwner, 'leaseOwner')
    assertFencingToken(fencingToken)
    assertTimestamp(createdAt, 'createdAt')
    if (leaseOwner !== this.managerOwner) {
      workspaceError(
        E3_WORKSPACE_ERROR.LEASE_MISMATCH,
        'Workspace lease owner is not this manager'
      )
    }

    const layout = this.prepareStorage()
    const paths = workspacePaths(layout, sessionId)
    const workspaceLock = acquireManagerLock(
      paths.workspaceLockPath,
      { owner: leaseOwner, acquiredAt: createdAt }
    )
    let mirrorLock
    let worktreeCreated = false
    let workspaceRootCreated = false

    try {
      mirrorLock = acquireManagerLock(
        join(layout.locksPath, 'mirror-update.lock'),
        { owner: leaseOwner, acquiredAt: createdAt }
      )
      this.repository.assertCurrentWorkspaceLease(
        sessionId,
        leaseOwner,
        fencingToken
      )
      const session = this.repository.getSession(sessionId)
      if (
        !session ||
        session.status !== E3_SESSION_STATUS.PROVISIONING
      ) {
        workspaceError(
          E3_WORKSPACE_ERROR.INVALID_SESSION_STATE,
          'Session must be provisioning'
        )
      }
      if (
        existsSync(paths.workspaceRoot) ||
        this.repository.getWorkspace(sessionId)
      ) {
        workspaceError(
          E3_WORKSPACE_ERROR.WORKSPACE_EXISTS,
          'Session workspace already exists'
        )
      }

      this.git.updateMirror()
      const treeSha = this.git.resolveTrustedCommit(
        session.base_commit
      )
      mkdirSync(paths.workspaceRoot, {
        recursive: false,
        mode: 0o750
      })
      workspaceRootCreated = true
      assertRealDirectory(
        paths.workspaceRoot,
        E3_WORKSPACE_ERROR.PATH_TAMPERED
      )

      this.git.addDetachedWorktree(
        paths.treePath,
        session.base_commit
      )
      worktreeCreated = true
      assertRealDirectory(
        paths.treePath,
        E3_WORKSPACE_ERROR.PATH_TAMPERED
      )
      chmodSync(join(paths.treePath, '.git'), 0o440)

      const scan = scanWorkspaceTree(paths.treePath)
      const manifest = freezeDomainValue({
        schemaVersion: E3_WORKSPACE_MANIFEST_VERSION,
        sessionId,
        workspaceKey: paths.workspaceKey,
        baseCommit: session.base_commit,
        treeSha,
        canonicalWorkspacePath: paths.treePath,
        managerOwner: leaseOwner,
        workerOwner: null,
        createdAt,
        heartbeatAt: createdAt,
        fencingToken,
        allowedRoots: [paths.treePath],
        expectedSubpaths: ['tree', 'manifest.json'],
        associatedProcesses: [],
        associatedContainers: [],
        portLeases: [],
        candidate: null,
        logicalSizeBytes: scan.logicalSizeBytes,
        entryCount: scan.entryCount,
        symlinkCount: scan.symlinkCount
      })
      const published = publishWorkspaceManifest(
        paths.manifestPath,
        manifest
      )
      const record = this.repository.registerWorkspace({
        sessionId,
        workspaceKey: paths.workspaceKey,
        baseCommit: session.base_commit,
        treeSha,
        canonicalPath: paths.treePath,
        manifestSha256: published.sha256,
        managerOwner: leaseOwner,
        createdAt,
        heartbeatAt: createdAt,
        fencingToken,
        ...scan
      })

      return freezeDomainValue({
        record,
        manifest,
        ageMs: 0
      })
    } catch (error) {
      try {
        this.#rollbackProvisioning({
          paths,
          worktreeCreated,
          workspaceRootCreated
        })
      } catch (rollbackError) {
        workspaceError(
          E3_WORKSPACE_ERROR.PROVISIONING_ROLLBACK_FAILED,
          'Workspace provisioning failed and rollback was incomplete',
          {},
          rollbackError
        )
      }
      throw error
    } finally {
      try {
        if (mirrorLock) mirrorLock.release()
      } finally {
        workspaceLock.release()
      }
    }
  }

  inspectWorkspace({
    sessionId,
    inspectedAt
  }) {
    this.#assertEnabled()
    assertCanonicalSessionId(sessionId)
    assertTimestamp(inspectedAt, 'inspectedAt')
    const layout = this.prepareStorage()
    const paths = workspacePaths(layout, sessionId)
    const lock = acquireManagerLock(
      paths.workspaceLockPath,
      { owner: this.managerOwner, acquiredAt: inspectedAt }
    )
    try {
      const record = this.repository.getWorkspace(sessionId)
      if (
        !record ||
        record.state !== E3_WORKSPACE_STATE.READY
      ) {
        workspaceError(
          E3_WORKSPACE_ERROR.WORKSPACE_NOT_FOUND,
          'Ready workspace metadata does not exist'
        )
      }
      this.repository.assertCurrentWorkspaceLease(
        sessionId,
        this.managerOwner,
        record.fencingToken
      )
      this.#assertWorkspaceIdentity(record, paths)
      const verified = readVerifiedWorkspaceManifest(
        paths.manifestPath,
        record.manifestSha256
      )
      assertManifestBinding(verified.manifest, record, paths)
      const scan = scanWorkspaceTree(paths.treePath)
      if (
        scan.logicalSizeBytes !== record.logicalSizeBytes ||
        scan.entryCount !== record.entryCount ||
        scan.symlinkCount !== record.symlinkCount
      ) {
        workspaceError(
          E3_WORKSPACE_ERROR.MANIFEST_MISMATCH,
          'Read-only workspace contents changed'
        )
      }
      return freezeDomainValue({
        record,
        manifest: verified.manifest,
        ageMs: Math.max(0, inspectedAt - record.createdAt),
        ...scan
      })
    } finally {
      lock.release()
    }
  }

  removeWorkspace({
    sessionId,
    leaseOwner,
    fencingToken,
    removedAt
  }) {
    this.#assertEnabled()
    assertCanonicalSessionId(sessionId)
    assertSafeToken(leaseOwner, 'leaseOwner')
    assertFencingToken(fencingToken)
    assertTimestamp(removedAt, 'removedAt')
    if (leaseOwner !== this.managerOwner) {
      workspaceError(
        E3_WORKSPACE_ERROR.LEASE_MISMATCH,
        'Workspace lease owner is not this manager'
      )
    }

    const layout = this.prepareStorage()
    const paths = workspacePaths(layout, sessionId)
    const workspaceLock = acquireManagerLock(
      paths.workspaceLockPath,
      { owner: leaseOwner, acquiredAt: removedAt }
    )
    let mirrorLock
    try {
      mirrorLock = acquireManagerLock(
        join(layout.locksPath, 'mirror-update.lock'),
        { owner: leaseOwner, acquiredAt: removedAt }
      )
      this.repository.assertCurrentWorkspaceLease(
        sessionId,
        leaseOwner,
        fencingToken
      )
      let record = this.repository.getWorkspace(sessionId)
      if (!record) {
        if (!existsSync(paths.workspaceRoot)) {
          return freezeDomainValue({
            removed: false,
            alreadyAbsent: true
          })
        }
        workspaceError(
          E3_WORKSPACE_ERROR.WORKSPACE_RECORD_MISMATCH,
          'Filesystem workspace has no DB record'
        )
      }
      if (record.state === E3_WORKSPACE_STATE.REMOVED) {
        if (existsSync(paths.workspaceRoot)) {
          workspaceError(
            E3_WORKSPACE_ERROR.WORKSPACE_RECORD_MISMATCH,
            'Removed workspace unexpectedly exists'
          )
        }
        return freezeDomainValue({
          removed: false,
          alreadyAbsent: true,
          record
        })
      }

      if (record.state === E3_WORKSPACE_STATE.READY) {
        this.#assertWorkspaceIdentity(record, paths)
        const verified = readVerifiedWorkspaceManifest(
          paths.manifestPath,
          record.manifestSha256
        )
        assertManifestBinding(verified.manifest, record, paths)
        record = this.repository.beginRemoval({
          sessionId,
          managerOwner: leaseOwner,
          fencingToken,
          occurredAt: removedAt
        })
      } else if (
        record.state !== E3_WORKSPACE_STATE.REMOVING
      ) {
        workspaceError(
          E3_WORKSPACE_ERROR.CLEANUP_BLOCKED,
          'Workspace is not in a removable state'
        )
      }

      if (existsSync(paths.workspaceRoot)) {
        assertRealDirectory(
          paths.workspaceRoot,
          E3_WORKSPACE_ERROR.PATH_TAMPERED
        )
        if (existsSync(paths.treePath)) {
          this.#assertWorkspaceIdentity(record, paths)
          const verified = readVerifiedWorkspaceManifest(
            paths.manifestPath,
            record.manifestSha256
          )
          assertManifestBinding(
            verified.manifest,
            record,
            paths
          )
        } else if (existsSync(paths.manifestPath)) {
          const verified = readVerifiedWorkspaceManifest(
            paths.manifestPath,
            record.manifestSha256
          )
          assertManifestBinding(
            verified.manifest,
            record,
            paths
          )
        }
      }

      if (this.git.isWorktreeRegistered(paths.treePath)) {
        this.git.removeWorktree(paths.treePath)
      }
      this.git.pruneWorktrees()

      if (existsSync(paths.treePath)) {
        workspaceError(
          E3_WORKSPACE_ERROR.CLEANUP_BLOCKED,
          'Git did not remove the exact worktree'
        )
      }
      if (existsSync(paths.manifestPath)) {
        const metadata = lstatSync(paths.manifestPath)
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
          workspaceError(
            E3_WORKSPACE_ERROR.PATH_TAMPERED,
            'Manifest path changed during cleanup'
          )
        }
        unlinkSync(paths.manifestPath)
      }
      if (existsSync(paths.workspaceRoot)) {
        assertRealDirectory(
          paths.workspaceRoot,
          E3_WORKSPACE_ERROR.PATH_TAMPERED
        )
        rmdirSync(paths.workspaceRoot)
      }

      const removedRecord = this.repository.completeRemoval({
        sessionId,
        managerOwner: leaseOwner,
        fencingToken,
        removedAt
      })
      return freezeDomainValue({
        removed: true,
        alreadyAbsent: false,
        record: removedRecord
      })
    } finally {
      try {
        if (mirrorLock) mirrorLock.release()
      } finally {
        workspaceLock.release()
      }
    }
  }

  #assertEnabled() {
    if (!this.enabled) {
      workspaceError(
        E3_WORKSPACE_ERROR.FEATURE_DISABLED,
        'E3 workspace feature is disabled'
      )
    }
  }

  #assertWorkspaceIdentity(record, paths) {
    if (
      record.workspaceKey !== paths.workspaceKey ||
      record.canonicalPath !== paths.treePath
    ) {
      workspaceError(
        E3_WORKSPACE_ERROR.WORKSPACE_RECORD_MISMATCH,
        'Workspace DB record does not match canonical paths'
      )
    }
    assertRealDirectory(
      paths.workspaceRoot,
      E3_WORKSPACE_ERROR.PATH_TAMPERED
    )
    assertRealDirectory(
      paths.treePath,
      E3_WORKSPACE_ERROR.PATH_TAMPERED
    )
    const manifestMetadata = lstatSync(paths.manifestPath)
    if (
      !manifestMetadata.isFile() ||
      manifestMetadata.isSymbolicLink()
    ) {
      workspaceError(
        E3_WORKSPACE_ERROR.PATH_TAMPERED,
        'Workspace manifest path is unsafe'
      )
    }
  }

  #rollbackProvisioning({
    paths,
    worktreeCreated,
    workspaceRootCreated
  }) {
    if (
      worktreeCreated &&
      this.git.isWorktreeRegistered(paths.treePath)
    ) {
      this.git.removeWorktree(paths.treePath)
      this.git.pruneWorktrees()
    }
    if (existsSync(paths.manifestPath)) {
      unlinkSync(paths.manifestPath)
    }
    if (existsSync(paths.treePath)) {
      rmdirSync(paths.treePath)
    }
    if (
      workspaceRootCreated &&
      existsSync(paths.workspaceRoot)
    ) {
      rmdirSync(paths.workspaceRoot)
    }
  }
}
