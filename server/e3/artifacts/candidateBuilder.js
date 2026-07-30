import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  E3_PATH_POLICY_VERSION
} from '../editor/contracts.js'
import { assertEditorPath } from '../editor/pathPolicy.js'
import { sha256 } from '../editor/safeTextFilesystem.js'
import {
  assertCanonicalSessionId,
  assertFullGitCommit
} from '../core/contracts.js'

const GIT = '/usr/bin/git'
const MAX_BUFFER = 128 * 1024 * 1024

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, canonical(value[key])])
    )
  }
  return value
}

function canonicalJson(value) {
  return `${JSON.stringify(canonical(value), null, 2)}\n`
}

function git(workspacePath, indexPath, args, encoding = null) {
  return execFileSync(GIT, args, {
    cwd: workspacePath,
    encoding,
    maxBuffer: MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: '/usr/bin:/bin',
      HOME: workspacePath,
      LC_ALL: 'C',
      LANG: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_INDEX_FILE: indexPath
    }
  })
}

function nulList(buffer) {
  return buffer.toString('utf8').split('\0').filter(Boolean)
}

export class CandidateBuilder {
  constructor({ gitPath = GIT } = {}) {
    if (gitPath !== GIT) {
      throw new Error('Candidate builder requires the pinned Git executable')
    }
  }

  build({
    sessionId,
    baseCommit,
    workspacePath,
    sessionVersion,
    operations,
    generatedAt
  }) {
    assertCanonicalSessionId(sessionId)
    assertFullGitCommit(baseCommit)
    const root = path.resolve(workspacePath)
    if (fs.realpathSync.native(root) !== root) {
      throw new Error('Workspace path is not canonical')
    }
    const temporary = fs.mkdtempSync(
      path.join(os.tmpdir(), 'e3-candidate-index-')
    )
    const indexPath = path.join(temporary, 'index')
    try {
      const actualHead = git(
        root,
        indexPath,
        ['rev-parse', 'HEAD'],
        'utf8'
      ).trim()
      if (actualHead !== baseCommit) {
        throw new Error('Workspace HEAD differs from session base commit')
      }
      git(root, indexPath, ['read-tree', baseCommit])
      git(root, indexPath, ['add', '-A', '--', '.'])
      const changedFiles = nulList(git(root, indexPath, [
        'diff', '--cached', '--name-only', '-z', baseCommit, '--'
      ])).sort()
      for (const relativePath of changedFiles) {
        assertEditorPath(relativePath, { mutation: true })
      }
      if (changedFiles.length === 0) {
        throw new Error('Candidate contains no changed files')
      }

      const patchArgs = [
        'diff', '--cached', '--binary', '--full-index', '--no-color',
        '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/',
        baseCommit, '--'
      ]
      const forwardPatch = git(root, indexPath, patchArgs)
      const reversePatch = git(root, indexPath, [
        ...patchArgs.slice(0, 2),
        '-R',
        ...patchArgs.slice(2)
      ])
      const unifiedDiff = git(root, indexPath, [
        'diff', '--cached', '--full-index', '--no-color', '--no-ext-diff',
        '--src-prefix=a/', '--dst-prefix=b/', baseCommit, '--'
      ])
      const diffStat = git(root, indexPath, [
        'diff', '--cached', '--stat', '--no-color',
        '--stat-width=120', '--stat-name-width=80', '--stat-count=1000',
        baseCommit, '--'
      ])
      const treeSha = git(
        root,
        indexPath,
        ['write-tree'],
        'utf8'
      ).trim()
      const entries = nulList(git(root, indexPath, [
        'ls-files', '--stage', '-z'
      ])).map(record => {
        const tab = record.indexOf('\t')
        const [mode, blobSha, stage] =
          record.slice(0, tab).split(' ')
        const relativePath = record.slice(tab + 1)
        if (stage !== '0') throw new Error('Candidate index is conflicted')
        const blob = git(root, indexPath, ['cat-file', 'blob', blobSha])
        return {
          path: relativePath,
          mode,
          blobSha,
          sha256: sha256(blob),
          bytes: blob.length
        }
      }).sort((a, b) => a.path.localeCompare(b.path, 'en'))
      const orderedOperations = [...operations]
        .sort((a, b) => a.sequence - b.sequence)
        .map(operation => ({
          sequence: operation.sequence,
          type: operation.type,
          pathBefore: operation.pathBefore,
          pathAfter: operation.pathAfter,
          preimageSha256: operation.preimageSha256,
          postimageSha256: operation.postimageSha256
        }))
      const manifest = Buffer.from(canonicalJson({
        version: 1,
        sessionId,
        sessionVersion,
        baseCommit,
        treeSha,
        pathPolicyVersion: E3_PATH_POLICY_VERSION,
        generatedAt,
        changedFiles,
        operations: orderedOperations,
        entries
      }))
      return Object.freeze({
        treeSha,
        changedFiles: Object.freeze(changedFiles),
        manifest,
        forwardPatch,
        reversePatch,
        unifiedDiff,
        diffStat
      })
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true })
    }
  }
}
