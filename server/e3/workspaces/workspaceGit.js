import {
  existsSync,
  lstatSync,
  readdirSync
} from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  assertFullGitCommit
} from '../core/contracts.js'
import {
  E3_WORKSPACE_ERROR,
  E3WorkspaceError
} from './errors.js'

const GIT_BINARY = '/usr/bin/git'
const TRUSTED_REF = 'refs/heads/e3-trusted-main'

function gitError(code, message, details = {}, cause) {
  throw new E3WorkspaceError(
    code,
    message,
    details,
    cause ? { cause } : {}
  )
}

function runFixedGit(args, {
  cwd,
  runtimeHome,
  allowedExitCodes = [0],
  timeoutMs = 60_000
}) {
  const result = spawnSync(GIT_BINARY, [
    '-c',
    'credential.helper=',
    '-c',
    'core.askPass=',
    '-c',
    'protocol.allow=never',
    '-c',
    'protocol.file.allow=always',
    ...args
  ], {
    cwd,
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: runtimeHome,
      XDG_CONFIG_HOME: runtimeHome,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '/bin/false',
      LC_ALL: 'C',
      LANG: 'C'
    }
  })

  if (
    result.error ||
    !allowedExitCodes.includes(result.status)
  ) {
    gitError(
      E3_WORKSPACE_ERROR.GIT_FAILED,
      'Fixed Git operation failed',
      {
        exitCode: result.status,
        stderr: String(result.stderr ?? '').slice(0, 2_000)
      },
      result.error
    )
  }

  return Object.freeze({
    status: result.status,
    stdout: String(result.stdout ?? '').trim(),
    stderr: String(result.stderr ?? '').trim()
  })
}

export class WorkspaceGit {
  constructor({
    mirrorPath,
    sourceRepositoryPath,
    runtimeHome,
    sourceRef = 'refs/heads/main'
  }) {
    if (sourceRef !== 'refs/heads/main') {
      gitError(
        E3_WORKSPACE_ERROR.INVALID_CONFIGURATION,
        'Only the trusted main source ref is supported'
      )
    }
    this.mirrorPath = mirrorPath
    this.sourceRepositoryPath = sourceRepositoryPath
    this.runtimeHome = runtimeHome
    this.sourceRef = sourceRef
  }

  initializeMirror() {
    if (!existsSync(this.mirrorPath)) {
      runFixedGit([
        'init',
        '--bare',
        '--initial-branch=main',
        this.mirrorPath
      ], {
        runtimeHome: this.runtimeHome
      })
    }

    const metadata = lstatSync(this.mirrorPath)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      gitError(
        E3_WORKSPACE_ERROR.MIRROR_UNSAFE,
        'Mirror path is not a real directory'
      )
    }
    const isBare = runFixedGit([
      '--git-dir',
      this.mirrorPath,
      'rev-parse',
      '--is-bare-repository'
    ], {
      runtimeHome: this.runtimeHome
    }).stdout
    if (isBare !== 'true') {
      gitError(
        E3_WORKSPACE_ERROR.MIRROR_UNSAFE,
        'Editor mirror is not bare'
      )
    }
  }

  updateMirror() {
    this.initializeMirror()
    this.assertCredentialFree()
    runFixedGit([
      '--git-dir',
      this.mirrorPath,
      'fetch',
      '--force',
      '--prune',
      '--no-tags',
      '--no-write-fetch-head',
      this.sourceRepositoryPath,
      `+${this.sourceRef}:${TRUSTED_REF}`
    ], {
      runtimeHome: this.runtimeHome
    })
    this.assertCredentialFree()
  }

  assertCredentialFree() {
    const remotes = runFixedGit([
      '--git-dir',
      this.mirrorPath,
      'remote'
    ], {
      runtimeHome: this.runtimeHome
    }).stdout
    const localConfig = runFixedGit([
      '--git-dir',
      this.mirrorPath,
      'config',
      '--local',
      '--name-only',
      '--list'
    ], {
      runtimeHome: this.runtimeHome
    })
    const allowedConfig = new Set([
      'core.repositoryformatversion',
      'core.filemode',
      'core.bare'
    ])
    const unsafeConfig = localConfig.stdout
      .split('\n')
      .filter(Boolean)
      .filter(key => !allowedConfig.has(key))
    const hooksPath = join(this.mirrorPath, 'hooks')
    const unsafeHooks = readdirSync(hooksPath)
      .filter(name => !name.endsWith('.sample'))
    const alternatesPath = join(
      this.mirrorPath,
      'objects',
      'info',
      'alternates'
    )
    const requiredPaths = [
      {
        path: join(this.mirrorPath, 'config'),
        type: 'file'
      },
      {
        path: join(this.mirrorPath, 'HEAD'),
        type: 'file'
      },
      {
        path: join(this.mirrorPath, 'objects'),
        type: 'directory'
      },
      {
        path: join(this.mirrorPath, 'refs'),
        type: 'directory'
      },
      {
        path: hooksPath,
        type: 'directory'
      }
    ]
    const unsafeRequiredPath = requiredPaths.some(required => {
      const metadata = lstatSync(required.path)
      return (
        metadata.isSymbolicLink() ||
        (
          required.type === 'file' &&
          !metadata.isFile()
        ) ||
        (
          required.type === 'directory' &&
          !metadata.isDirectory()
        )
      )
    })

    if (
      remotes ||
      unsafeConfig.length > 0 ||
      unsafeHooks.length > 0 ||
      existsSync(alternatesPath) ||
      unsafeRequiredPath
    ) {
      gitError(
        E3_WORKSPACE_ERROR.MIRROR_UNSAFE,
        'Editor mirror retains unsafe configuration or execution hooks'
      )
    }
  }

  resolveTrustedCommit(baseCommit) {
    assertFullGitCommit(baseCommit)
    const object = runFixedGit([
      '--git-dir',
      this.mirrorPath,
      'cat-file',
      '-e',
      `${baseCommit}^{commit}`
    ], {
      runtimeHome: this.runtimeHome,
      allowedExitCodes: [0, 1, 128]
    })
    if (object.status !== 0) {
      gitError(
        E3_WORKSPACE_ERROR.COMMIT_NOT_FOUND,
        'Base commit is not present in the editor mirror'
      )
    }

    const reachable = runFixedGit([
      '--git-dir',
      this.mirrorPath,
      'merge-base',
      '--is-ancestor',
      baseCommit,
      TRUSTED_REF
    ], {
      runtimeHome: this.runtimeHome,
      allowedExitCodes: [0, 1]
    })
    if (reachable.status !== 0) {
      gitError(
        E3_WORKSPACE_ERROR.COMMIT_UNREACHABLE,
        'Base commit is outside trusted main history'
      )
    }

    return runFixedGit([
      '--git-dir',
      this.mirrorPath,
      'rev-parse',
      `${baseCommit}^{tree}`
    ], {
      runtimeHome: this.runtimeHome
    }).stdout
  }

  addDetachedWorktree(treePath, baseCommit) {
    assertFullGitCommit(baseCommit)
    runFixedGit([
      '--git-dir',
      this.mirrorPath,
      'worktree',
      'add',
      '--detach',
      treePath,
      baseCommit
    ], {
      runtimeHome: this.runtimeHome
    })
  }

  removeWorktree(treePath) {
    runFixedGit([
      '--git-dir',
      this.mirrorPath,
      'worktree',
      'remove',
      '--force',
      treePath
    ], {
      runtimeHome: this.runtimeHome
    })
  }

  isWorktreeRegistered(treePath) {
    const listing = runFixedGit([
      '--git-dir',
      this.mirrorPath,
      'worktree',
      'list',
      '--porcelain'
    ], {
      runtimeHome: this.runtimeHome
    }).stdout
    return listing
      .split('\n')
      .some(line => line === `worktree ${treePath}`)
  }

  pruneWorktrees() {
    runFixedGit([
      '--git-dir',
      this.mirrorPath,
      'worktree',
      'prune',
      '--expire=now'
    ], {
      runtimeHome: this.runtimeHome
    })
  }
}
