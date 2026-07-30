import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  assertCanonicalSessionId,
  assertFullGitCommit,
  assertSha256,
  freezeDomainValue
} from '../core/contracts.js'
import {
  E3_VALIDATION_ERROR,
  E3ValidationError
} from './errors.js'

const GIT = '/usr/bin/git'
const TAR = '/usr/bin/tar'
const MAX_ENTRIES = 100_000
const MAX_BYTES = 2 * 1024 * 1024 * 1024
const MAX_PATCH_BYTES = 128 * 1024 * 1024
const SAFE_ENVIRONMENT = Object.freeze({
  PATH: '/usr/bin:/bin',
  HOME: '/nonexistent',
  LANG: 'C',
  LC_ALL: 'C',
  TZ: 'UTC',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_OPTIONAL_LOCKS: '0'
})

function snapshotError(code, message, details = {}, cause) {
  throw new E3ValidationError(
    code,
    message,
    details,
    cause ? { cause } : {}
  )
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function isWithin(root, candidate) {
  return candidate === root ||
    candidate.startsWith(`${root}${path.sep}`)
}

function assertRoot(rootPath, fieldName, forbiddenRoots) {
  const resolved = path.resolve(rootPath)
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 })
  const actual = fs.realpathSync.native(resolved)
  const stat = fs.lstatSync(actual)
  if (
    actual !== resolved ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    forbiddenRoots.some(root => isWithin(path.resolve(root), actual))
  ) {
    snapshotError(
      E3_VALIDATION_ERROR.INVALID_SNAPSHOT,
      `${fieldName} is not an allowed canonical directory`
    )
  }
  return actual
}

function assertMirror(mirrorPath, forbiddenRoots) {
  const resolved = path.resolve(mirrorPath)
  const actual = fs.realpathSync.native(resolved)
  const stat = fs.lstatSync(actual)
  if (
    actual !== resolved ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    forbiddenRoots.some(root => isWithin(path.resolve(root), actual))
  ) {
    snapshotError(
      E3_VALIDATION_ERROR.INVALID_SNAPSHOT,
      'Git mirror is not an allowed canonical directory'
    )
  }
  return actual
}

function command(executable, args, options = {}) {
  return execFileSync(executable, args, {
    cwd: options.cwd,
    encoding: options.encoding ?? null,
    maxBuffer: 128 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: SAFE_ENVIRONMENT
  })
}

function parseManifest(bytes, expectedSha256) {
  assertSha256(expectedSha256, 'candidateManifestSha256')
  const buffer = Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes)
  if (sha256(buffer) !== expectedSha256) {
    snapshotError(
      E3_VALIDATION_ERROR.INVALID_CANDIDATE,
      'Candidate manifest hash does not match'
    )
  }
  let manifest
  try {
    manifest = JSON.parse(buffer.toString('utf8'))
  } catch (cause) {
    snapshotError(
      E3_VALIDATION_ERROR.INVALID_CANDIDATE,
      'Candidate manifest is not valid JSON',
      {},
      cause
    )
  }
  if (
    manifest?.version !== 1 ||
    !Array.isArray(manifest.entries) ||
    manifest.entries.length > MAX_ENTRIES
  ) {
    snapshotError(
      E3_VALIDATION_ERROR.INVALID_CANDIDATE,
      'Candidate manifest schema is unsupported'
    )
  }
  return manifest
}

function scanTree(root) {
  const entries = []
  let totalBytes = 0
  const visit = relativeDirectory => {
    const absoluteDirectory = relativeDirectory
      ? path.join(root, relativeDirectory)
      : root
    const names = fs.readdirSync(absoluteDirectory)
      .sort((a, b) => a.localeCompare(b, 'en'))
    for (const name of names) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${name}`
        : name
      const absolutePath = path.join(root, ...relativePath.split('/'))
      const stat = fs.lstatSync(absolutePath)
      if (stat.isSymbolicLink()) {
        snapshotError(
          E3_VALIDATION_ERROR.INVALID_SNAPSHOT,
          'Validation snapshot contains a symlink',
          { path: relativePath }
        )
      }
      if (stat.isDirectory()) {
        visit(relativePath)
        continue
      }
      if (!stat.isFile() || stat.nlink !== 1) {
        snapshotError(
          E3_VALIDATION_ERROR.INVALID_SNAPSHOT,
          'Validation snapshot contains an unsupported entry',
          { path: relativePath }
        )
      }
      const bytes = fs.readFileSync(absolutePath)
      totalBytes += bytes.length
      if (
        entries.length >= MAX_ENTRIES ||
        totalBytes > MAX_BYTES
      ) {
        snapshotError(
          E3_VALIDATION_ERROR.INVALID_SNAPSHOT,
          'Validation snapshot exceeds the V1 limits'
        )
      }
      entries.push({
        path: relativePath,
        mode: stat.mode & 0o111 ? '100755' : '100644',
        sha256: sha256(bytes),
        bytes: bytes.length
      })
    }
  }
  visit('')
  return entries
}

function expectedEntries(manifest) {
  return manifest.entries.map(entry => ({
    path: entry.path,
    mode: entry.mode,
    sha256: entry.sha256,
    bytes: entry.bytes
  }))
}

function makeReadOnly(root) {
  const visit = current => {
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink()) {
      snapshotError(
        E3_VALIDATION_ERROR.INVALID_SNAPSHOT,
        'Symlink appeared while sealing validation snapshot'
      )
    }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(current)) {
        visit(path.join(current, name))
      }
      fs.chmodSync(current, 0o555)
      return
    }
    fs.chmodSync(current, stat.mode & 0o111 ? 0o555 : 0o444)
  }
  visit(root)
}

function assertReadOnly(root) {
  const visit = current => {
    const stat = fs.lstatSync(current)
    if (
      stat.isSymbolicLink() ||
      (stat.mode & 0o222) !== 0
    ) {
      snapshotError(
        E3_VALIDATION_ERROR.SNAPSHOT_TAMPERED,
        'Validation snapshot is not sealed read-only'
      )
    }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(current)) {
        visit(path.join(current, name))
      }
    }
  }
  visit(root)
}

function makeRemovable(root) {
  if (!fs.existsSync(root)) return
  const stat = fs.lstatSync(root)
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    fs.chmodSync(root, 0o700)
    for (const name of fs.readdirSync(root)) {
      makeRemovable(path.join(root, name))
    }
  } else if (!stat.isSymbolicLink()) {
    fs.chmodSync(root, 0o600)
  }
}

export function validationSnapshotHandle(sessionId, runId) {
  assertCanonicalSessionId(sessionId)
  assertCanonicalSessionId(runId)
  return `validation:${sessionId}:${runId}`
}

export class ValidationSnapshotMaterializer {
  constructor({
    snapshotRoot,
    mirrorPath,
    forbiddenRoots = ['/root/echolink'],
    idFactory = randomUUID,
    gitPath = GIT,
    tarPath = TAR
  }) {
    if (gitPath !== GIT || tarPath !== TAR) {
      snapshotError(
        E3_VALIDATION_ERROR.INVALID_SNAPSHOT,
        'Validation snapshot requires pinned Git and tar executables'
      )
    }
    this.forbiddenRoots = [...forbiddenRoots]
    this.snapshotRoot = assertRoot(
      snapshotRoot,
      'snapshotRoot',
      this.forbiddenRoots
    )
    this.mirrorPath = assertMirror(mirrorPath, this.forbiddenRoots)
    this.idFactory = idFactory
  }

  materialize({
    runId,
    sessionId,
    baseCommit,
    candidateManifestSha256,
    manifestBytes,
    forwardPatch
  }) {
    assertCanonicalSessionId(runId)
    assertCanonicalSessionId(sessionId)
    assertFullGitCommit(baseCommit)
    const manifest = parseManifest(
      manifestBytes,
      candidateManifestSha256
    )
    if (
      !Buffer.isBuffer(forwardPatch) &&
      typeof forwardPatch !== 'string'
    ) {
      snapshotError(
        E3_VALIDATION_ERROR.INVALID_CANDIDATE,
        'Candidate patch must be bytes or text'
      )
    }
    const patchBytes = Buffer.isBuffer(forwardPatch)
      ? forwardPatch
      : Buffer.from(forwardPatch)
    if (patchBytes.length > MAX_PATCH_BYTES) {
      snapshotError(
        E3_VALIDATION_ERROR.INVALID_CANDIDATE,
        'Candidate patch exceeds the V1 limit'
      )
    }
    if (
      manifest.sessionId !== sessionId ||
      manifest.baseCommit !== baseCommit
    ) {
      snapshotError(
        E3_VALIDATION_ERROR.INVALID_CANDIDATE,
        'Candidate manifest identity does not match the request'
      )
    }
    const sessionRoot = path.join(this.snapshotRoot, sessionId)
    fs.mkdirSync(sessionRoot, { recursive: true, mode: 0o700 })
    const finalPath = path.join(sessionRoot, runId)
    if (fs.existsSync(finalPath)) {
      snapshotError(
        E3_VALIDATION_ERROR.INVALID_SNAPSHOT,
        'Validation snapshot already exists'
      )
    }
    const stageRoot = path.join(
      sessionRoot,
      `.${runId}.stage-${this.idFactory()}`
    )
    const treePath = path.join(stageRoot, 'tree')
    const archivePath = path.join(stageRoot, 'base.tar')
    const patchPath = path.join(stageRoot, 'candidate.patch')
    fs.mkdirSync(treePath, { recursive: true, mode: 0o700 })
    try {
      command(GIT, [
        `--git-dir=${this.mirrorPath}`,
        'archive',
        '--format=tar',
        `--output=${archivePath}`,
        baseCommit
      ])
      command(TAR, [
        '--extract',
        `--file=${archivePath}`,
        `--directory=${treePath}`,
        '--no-same-owner',
        '--no-same-permissions'
      ])
      scanTree(treePath)
      fs.writeFileSync(patchPath, patchBytes, {
        mode: 0o600,
        flag: 'wx'
      })
      command(GIT, [
        '-C',
        treePath,
        'apply',
        '--check',
        '--whitespace=nowarn',
        patchPath
      ])
      command(GIT, [
        '-C',
        treePath,
        'apply',
        '--whitespace=nowarn',
        patchPath
      ])
      const actualEntries = scanTree(treePath)
      if (
        JSON.stringify(actualEntries) !==
        JSON.stringify(expectedEntries(manifest))
      ) {
        snapshotError(
          E3_VALIDATION_ERROR.SNAPSHOT_TAMPERED,
          'Materialized tree does not match the candidate manifest'
        )
      }
      makeReadOnly(treePath)
      assertReadOnly(treePath)
      fs.renameSync(treePath, finalPath)
      makeRemovable(stageRoot)
      fs.rmSync(stageRoot, { recursive: true, force: true })
      return freezeDomainValue({
        handle: validationSnapshotHandle(sessionId, runId),
        path: finalPath,
        sessionId,
        runId,
        baseCommit,
        candidateManifestSha256,
        entryCount: actualEntries.length,
        logicalSizeBytes: actualEntries.reduce(
          (sum, entry) => sum + entry.bytes,
          0
        )
      })
    } catch (error) {
      if (fs.existsSync(finalPath)) {
        makeRemovable(finalPath)
        fs.rmSync(finalPath, { recursive: true, force: true })
      }
      makeRemovable(stageRoot)
      fs.rmSync(stageRoot, { recursive: true, force: true })
      if (error instanceof E3ValidationError) throw error
      snapshotError(
        E3_VALIDATION_ERROR.INVALID_SNAPSHOT,
        'Validation snapshot materialization failed',
        {},
        error
      )
    }
  }

  verify(snapshot, manifestBytes) {
    let canonicalPath
    try {
      canonicalPath = fs.realpathSync.native(snapshot.path)
    } catch (cause) {
      snapshotError(
        E3_VALIDATION_ERROR.INVALID_SNAPSHOT,
        'Validation snapshot path does not exist',
        {},
        cause
      )
    }
    if (
      snapshot.handle !== validationSnapshotHandle(
        snapshot.sessionId,
        snapshot.runId
      ) ||
      canonicalPath !== snapshot.path ||
      !isWithin(this.snapshotRoot, snapshot.path)
    ) {
      snapshotError(
        E3_VALIDATION_ERROR.INVALID_SNAPSHOT,
        'Validation snapshot handle or path is invalid'
      )
    }
    const manifest = parseManifest(
      manifestBytes,
      snapshot.candidateManifestSha256
    )
    const actualEntries = scanTree(snapshot.path)
    assertReadOnly(snapshot.path)
    if (
      JSON.stringify(actualEntries) !==
      JSON.stringify(expectedEntries(manifest))
    ) {
      snapshotError(
        E3_VALIDATION_ERROR.SNAPSHOT_TAMPERED,
        'Validation snapshot changed after materialization'
      )
    }
    return true
  }

  remove(snapshot) {
    if (
      !snapshot ||
      !isWithin(this.snapshotRoot, path.resolve(snapshot.path)) ||
      path.resolve(snapshot.path) === this.snapshotRoot
    ) {
      snapshotError(
        E3_VALIDATION_ERROR.CLEANUP_FAILED,
        'Validation snapshot cleanup target is invalid'
      )
    }
    makeRemovable(snapshot.path)
    fs.rmSync(snapshot.path, { recursive: true, force: true })
    if (fs.existsSync(snapshot.path)) {
      snapshotError(
        E3_VALIDATION_ERROR.CLEANUP_FAILED,
        'Validation snapshot survived cleanup'
      )
    }
    const sessionRoot = path.dirname(snapshot.path)
    if (
      sessionRoot !== this.snapshotRoot &&
      fs.existsSync(sessionRoot) &&
      fs.readdirSync(sessionRoot).length === 0
    ) {
      fs.rmdirSync(sessionRoot)
    }
    return true
  }
}
