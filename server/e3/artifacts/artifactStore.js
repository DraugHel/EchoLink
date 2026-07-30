import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  assertCanonicalSessionId,
  assertSha256
} from '../core/contracts.js'
import { sha256 } from '../editor/safeTextFilesystem.js'

const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0
const DEFAULT_MAX_BYTES = 128 * 1024 * 1024

function assertRealDirectory(directory) {
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Artifact directory is not a real directory')
  }
  if (fs.realpathSync.native(directory) !== path.resolve(directory)) {
    throw new Error('Artifact directory is not canonical')
  }
}

function fsyncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY)
  try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}

export class ArtifactStore {
  constructor(root, { maxArtifactBytes = DEFAULT_MAX_BYTES } = {}) {
    this.root = path.resolve(root)
    this.maxArtifactBytes = maxArtifactBytes
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 })
    assertRealDirectory(this.root)
  }

  publish(content) {
    const buffer = Buffer.isBuffer(content)
      ? Buffer.from(content)
      : Buffer.from(String(content), 'utf8')
    if (buffer.length > this.maxArtifactBytes) {
      throw new Error('Artifact exceeds configured byte limit')
    }
    const digest = sha256(buffer)
    const directory = path.join(
      this.root,
      'objects',
      'sha256',
      digest.slice(0, 2)
    )
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    assertRealDirectory(directory)
    const target = path.join(directory, digest.slice(2))
    const stage = path.join(directory, `.e3-artifact-${randomUUID()}`)
    if (!fs.existsSync(target)) {
      let fd
      try {
        fd = fs.openSync(stage,
          fs.constants.O_WRONLY | fs.constants.O_CREAT |
          fs.constants.O_EXCL | NOFOLLOW,
          0o600)
        fs.writeFileSync(fd, buffer)
        fs.fsyncSync(fd)
        fs.closeSync(fd)
        fd = undefined
        try {
          fs.linkSync(stage, target)
        } catch (error) {
          if (error.code !== 'EEXIST') throw error
        }
        fsyncDirectory(directory)
      } finally {
        if (fd !== undefined) fs.closeSync(fd)
        try { fs.unlinkSync(stage) } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
      }
    }
    const verified = this.read(digest)
    if (!verified.equals(buffer)) {
      throw new Error('Existing artifact differs from its content address')
    }
    return Object.freeze({
      sha256: digest,
      storageKey: `objects/sha256/${digest.slice(0, 2)}/${digest.slice(2)}`,
      sizeBytes: buffer.length
    })
  }

  read(digest) {
    assertSha256(digest)
    const target = path.join(
      this.root,
      'objects',
      'sha256',
      digest.slice(0, 2),
      digest.slice(2)
    )
    const before = fs.lstatSync(target)
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new Error('Artifact object is not a regular file')
    }
    const fd = fs.openSync(target, fs.constants.O_RDONLY | NOFOLLOW)
    try {
      const opened = fs.fstatSync(fd)
      if (
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.size !== before.size
      ) {
        throw new Error('Artifact identity changed during open')
      }
      const content = fs.readFileSync(fd)
      if (sha256(content) !== digest) {
        throw new Error('Artifact failed SHA-256 verification')
      }
      return content
    } finally {
      fs.closeSync(fd)
    }
  }

  publishSessionManifest(sessionId, digest) {
    assertCanonicalSessionId(sessionId)
    assertSha256(digest)
    this.read(digest)
    const directory = path.join(this.root, 'sessions', sessionId)
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    assertRealDirectory(directory)
    const target = path.join(directory, `candidate-${digest}.json`)
    if (!fs.existsSync(target)) {
      const object = path.join(
        this.root,
        'objects',
        'sha256',
        digest.slice(0, 2),
        digest.slice(2)
      )
      fs.linkSync(object, target)
      fsyncDirectory(directory)
    }
    if (!this.read(digest).equals(fs.readFileSync(target))) {
      throw new Error('Logical session manifest is inconsistent')
    }
    return path.relative(this.root, target)
  }
}
