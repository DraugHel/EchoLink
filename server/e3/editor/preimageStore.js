import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { sha256 } from './safeTextFilesystem.js'

const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0

function assertDirectory(directory) {
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Preimage store path is not a real directory')
  }
  if (fs.realpathSync.native(directory) !== path.resolve(directory)) {
    throw new Error('Preimage store path is not canonical')
  }
}

export class PreimageStore {
  constructor(root) {
    this.root = path.resolve(root)
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 })
    assertDirectory(this.root)
  }

  retain({ sha256: expectedSha256, content }) {
    const buffer = Buffer.from(content)
    if (sha256(buffer) !== expectedSha256) {
      throw new Error('Preimage content does not match its SHA-256')
    }
    const directory = path.join(
      this.root,
      'preimages',
      'sha256',
      expectedSha256.slice(0, 2)
    )
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    assertDirectory(directory)
    const target = path.join(directory, expectedSha256)
    const stage = path.join(directory, `.e3-preimage-${randomUUID()}`)
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
      } finally {
        if (fd !== undefined) fs.closeSync(fd)
        try { fs.unlinkSync(stage) } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
      }
    }
    const stored = this.read(expectedSha256)
    if (!stored.equals(buffer)) {
      throw new Error('Existing preimage object differs from its digest')
    }
    return Object.freeze({
      sha256: expectedSha256,
      storageKey: path.relative(this.root, target),
      sizeBytes: buffer.length
    })
  }

  read(expectedSha256) {
    const target = path.join(
      this.root,
      'preimages',
      'sha256',
      expectedSha256.slice(0, 2),
      expectedSha256
    )
    const before = fs.lstatSync(target)
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new Error('Preimage object is not a regular file')
    }
    const fd = fs.openSync(target, fs.constants.O_RDONLY | NOFOLLOW)
    try {
      const opened = fs.fstatSync(fd)
      if (opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new Error('Preimage object changed during open')
      }
      const content = fs.readFileSync(fd)
      if (sha256(content) !== expectedSha256) {
        throw new Error('Preimage object failed digest verification')
      }
      return content
    } finally {
      fs.closeSync(fd)
    }
  }
}
