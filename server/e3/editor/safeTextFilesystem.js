import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { TextDecoder } from 'node:util'
import { E3_EDITOR_LIMITS } from './contracts.js'
import { E3_EDITOR_ERROR, E3EditorError } from './errors.js'
import { assertEditorPath } from './pathPolicy.js'

const UTF8 = new TextDecoder('utf-8', { fatal: true })
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0

function fail(code, message, details = {}, cause) {
  throw new E3EditorError(code, message, details, cause ? { cause } : {})
}

export function sha256(content) {
  return createHash('sha256').update(content).digest('hex')
}

function identity(stat) {
  return `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}`
}

function directoryIdentity(stat) {
  return `${stat.dev}:${stat.ino}:${stat.mode}`
}

function statOptions() {
  return { bigint: true }
}

function mapFsError(error, relativePath) {
  if (error instanceof E3EditorError) throw error
  if (error?.code === 'ENOENT') {
    fail(E3_EDITOR_ERROR.FILE_NOT_FOUND, 'Editor path does not exist', {
      relativePath
    }, error)
  }
  if (error?.code === 'EEXIST') {
    fail(E3_EDITOR_ERROR.FILE_EXISTS, 'Editor path already exists', {
      relativePath
    }, error)
  }
  if (error?.code === 'ELOOP') {
    fail(E3_EDITOR_ERROR.SYMLINK_BLOCKED, 'Symbolic links are not followed', {
      relativePath
    }, error)
  }
  throw error
}

export class SafeTextFilesystem {
  constructor(root, {
    limits = E3_EDITOR_LIMITS,
    assertLease = () => {},
    retainPreimage = () => null,
    faultInjector = () => {}
  } = {}) {
    if (!path.isAbsolute(root)) {
      fail(E3_EDITOR_ERROR.INVALID_REQUEST, 'Workspace root must be absolute')
    }
    const resolved = path.resolve(root)
    let rootStat
    try {
      rootStat = fs.lstatSync(resolved, statOptions())
    } catch (error) {
      mapFsError(error, '.')
    }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      fail(E3_EDITOR_ERROR.NOT_DIRECTORY, 'Workspace root is not a real directory')
    }
    if (fs.realpathSync.native(resolved) !== resolved) {
      fail(E3_EDITOR_ERROR.PATH_TAMPERED, 'Workspace root is not canonical')
    }
    this.root = resolved
    this.rootIdentity = directoryIdentity(rootStat)
    this.limits = limits
    this.assertLease = assertLease
    this.retainPreimage = retainPreimage
    this.faultInjector = faultInjector
  }

  #absolute(relativePath, mutation = false) {
    const validated = assertEditorPath(relativePath, { mutation })
    const absolute = path.join(this.root, ...validated.segments)
    if (!absolute.startsWith(`${this.root}${path.sep}`)) {
      fail(E3_EDITOR_ERROR.PATH_TAMPERED, 'Resolved path escaped workspace')
    }
    return absolute
  }

  #assertRoot() {
    const current = fs.lstatSync(this.root, statOptions())
    if (
      !current.isDirectory() ||
      directoryIdentity(current) !== this.rootIdentity
    ) {
      fail(E3_EDITOR_ERROR.PATH_TAMPERED, 'Workspace root identity changed')
    }
  }

  #assertParents(relativePath) {
    this.#assertRoot()
    const segments = relativePath.split('/')
    let current = this.root
    for (const segment of segments.slice(0, -1)) {
      current = path.join(current, segment)
      let entry
      try {
        entry = fs.lstatSync(current, statOptions())
      } catch (error) {
        mapFsError(error, relativePath)
      }
      if (entry.isSymbolicLink()) {
        fail(E3_EDITOR_ERROR.SYMLINK_BLOCKED, 'Parent symbolic link is blocked', {
          relativePath
        })
      }
      if (!entry.isDirectory()) {
        fail(E3_EDITOR_ERROR.NOT_DIRECTORY, 'Parent is not a directory', {
          relativePath
        })
      }
    }
  }

  #lstat(relativePath, mutation = false) {
    this.#assertParents(relativePath)
    try {
      return fs.lstatSync(this.#absolute(relativePath, mutation), statOptions())
    } catch (error) {
      mapFsError(error, relativePath)
    }
  }

  #read(relativePath, { mutation = false } = {}) {
    const absolute = this.#absolute(relativePath, mutation)
    const before = this.#lstat(relativePath, mutation)
    if (before.isSymbolicLink()) {
      fail(E3_EDITOR_ERROR.SYMLINK_BLOCKED, 'Symbolic links are not followed', {
        relativePath
      })
    }
    if (!before.isFile()) {
      fail(E3_EDITOR_ERROR.NOT_REGULAR_FILE, 'Path is not a regular file', {
        relativePath
      })
    }
    if (mutation && before.nlink > 1n) {
      fail(E3_EDITOR_ERROR.HARDLINK_BLOCKED, 'Hard-linked mutation target is blocked', {
        relativePath
      })
    }
    if (before.size > BigInt(this.limits.maxFileBytes)) {
      fail(E3_EDITOR_ERROR.FILE_TOO_LARGE, 'File exceeds editor byte limit', {
        relativePath
      })
    }
    let descriptor
    try {
      descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | NOFOLLOW)
      const opened = fs.fstatSync(descriptor, statOptions())
      if (identity(opened) !== identity(before)) {
        fail(E3_EDITOR_ERROR.PATH_TAMPERED, 'File identity changed while opening', {
          relativePath
        })
      }
      const buffer = fs.readFileSync(descriptor)
      let text
      try {
        text = UTF8.decode(buffer)
      } catch (error) {
        fail(E3_EDITOR_ERROR.BINARY_FILE_BLOCKED, 'File is not valid UTF-8', {
          relativePath
        }, error)
      }
      if (text.includes('\0')) {
        fail(E3_EDITOR_ERROR.BINARY_FILE_BLOCKED, 'NUL-containing file is blocked', {
          relativePath
        })
      }
      return {
        buffer,
        text,
        sha256: sha256(buffer),
        stat: opened,
        identity: identity(opened)
      }
    } catch (error) {
      mapFsError(error, relativePath)
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor)
    }
  }

  readFile(relativePath) {
    const file = this.#read(relativePath)
    return Object.freeze({
      path: relativePath,
      content: file.text,
      sha256: file.sha256,
      bytes: file.buffer.length
    })
  }

  statFile(relativePath) {
    const entry = this.#lstat(relativePath)
    return Object.freeze({
      path: relativePath,
      kind: entry.isSymbolicLink()
        ? 'symlink'
        : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
      bytes: Number(entry.size),
      links: Number(entry.nlink)
    })
  }

  listFiles(relativePath = null) {
    const absolute = relativePath ? this.#absolute(relativePath) : this.root
    if (relativePath) {
      const entry = this.#lstat(relativePath)
      if (entry.isSymbolicLink()) {
        fail(E3_EDITOR_ERROR.SYMLINK_BLOCKED, 'Directory symbolic link is blocked')
      }
      if (!entry.isDirectory()) {
        fail(E3_EDITOR_ERROR.NOT_DIRECTORY, 'List target is not a directory')
      }
    } else {
      this.#assertRoot()
    }
    return Object.freeze(fs.readdirSync(absolute, { withFileTypes: true })
      .map(entry => Object.freeze({
        name: entry.name,
        kind: entry.isSymbolicLink()
          ? 'symlink'
          : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other'
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'en')))
  }

  searchText(relativePath, query, maxResults) {
    const results = []
    const start = relativePath ?? null
    const visit = current => {
      if (results.length >= maxResults) return
      const entries = this.listFiles(current)
      for (const entry of entries) {
        if (results.length >= maxResults) break
        const child = current ? `${current}/${entry.name}` : entry.name
        try {
          assertEditorPath(child)
        } catch {
          continue
        }
        if (entry.kind === 'directory') {
          visit(child)
        } else if (entry.kind === 'file') {
          let file
          try {
            file = this.#read(child)
          } catch (error) {
            if ([
              E3_EDITOR_ERROR.BINARY_FILE_BLOCKED,
              E3_EDITOR_ERROR.FILE_TOO_LARGE
            ].includes(error.code)) continue
            throw error
          }
          let offset = 0
          while ((offset = file.text.indexOf(query, offset)) !== -1) {
            results.push(Object.freeze({ path: child, offset }))
            offset += query.length
            if (results.length >= maxResults) break
          }
        }
      }
    }
    if (start) {
      const entry = this.#lstat(start)
      if (entry.isFile()) {
        const file = this.#read(start)
        let offset = 0
        while ((offset = file.text.indexOf(query, offset)) !== -1 &&
          results.length < maxResults) {
          results.push(Object.freeze({ path: start, offset }))
          offset += query.length
        }
      } else if (entry.isDirectory()) {
        visit(start)
      } else {
        fail(E3_EDITOR_ERROR.NOT_DIRECTORY, 'Search root is not searchable')
      }
    } else {
      visit(null)
    }
    return Object.freeze(results)
  }

  #guard() {
    try {
      this.assertLease()
    } catch (error) {
      fail(E3_EDITOR_ERROR.LEASE_REJECTED, 'Workspace lease was rejected', {}, error)
    }
  }

  #retain(relativePath, file) {
    try {
      return this.retainPreimage(Object.freeze({
        path: relativePath,
        sha256: file.sha256,
        content: Buffer.from(file.buffer)
      })) ?? null
    } catch (error) {
      fail(E3_EDITOR_ERROR.PREIMAGE_RETENTION_FAILED, 'Preimage retention failed', {
        relativePath
      }, error)
    }
  }

  #writeAtomic(relativePath, content, { expected = null, create = false } = {}) {
    const buffer = Buffer.from(content, 'utf8')
    if (buffer.length > this.limits.maxFileBytes) {
      fail(E3_EDITOR_ERROR.FILE_TOO_LARGE, 'Result exceeds editor byte limit')
    }
    this.#assertParents(relativePath)
    const absolute = this.#absolute(relativePath, true)
    const parent = path.dirname(absolute)
    const parentBefore = fs.lstatSync(parent, statOptions())
    let prior = null
    if (create) {
      if (fs.existsSync(absolute)) {
        fail(E3_EDITOR_ERROR.FILE_EXISTS, 'Create target already exists')
      }
    } else {
      prior = this.#read(relativePath, { mutation: true })
      if (prior.sha256 !== expected) {
        fail(E3_EDITOR_ERROR.PREIMAGE_MISMATCH, 'File preimage does not match')
      }
    }
    const artifact = prior ? this.#retain(relativePath, prior) : null
    const stage = path.join(parent, `.e3-stage-${randomUUID()}`)
    let descriptor
    let published = false
    try {
      descriptor = fs.openSync(stage,
        fs.constants.O_WRONLY | fs.constants.O_CREAT |
        fs.constants.O_EXCL | NOFOLLOW,
        prior ? Number(prior.stat.mode & 0o777n) : 0o640)
      fs.writeFileSync(descriptor, buffer)
      fs.fsyncSync(descriptor)
      fs.closeSync(descriptor)
      descriptor = undefined
      this.faultInjector('staged', { relativePath })
      this.#guard()
      this.#assertParents(relativePath)
      if (
        directoryIdentity(fs.lstatSync(parent, statOptions())) !==
        directoryIdentity(parentBefore)
      ) {
        fail(E3_EDITOR_ERROR.PATH_TAMPERED, 'Parent changed before publication')
      }
      if (create) {
        if (fs.existsSync(absolute)) {
          fail(E3_EDITOR_ERROR.FILE_EXISTS, 'Create target appeared before publication')
        }
      } else {
        const current = this.#read(relativePath, { mutation: true })
        if (current.identity !== prior.identity || current.sha256 !== prior.sha256) {
          fail(E3_EDITOR_ERROR.PATH_TAMPERED, 'File changed before publication')
        }
      }
      fs.renameSync(stage, absolute)
      published = true
      const dirFd = fs.openSync(parent, fs.constants.O_RDONLY)
      try { fs.fsyncSync(dirFd) } finally { fs.closeSync(dirFd) }
      this.faultInjector('published', { relativePath })
      return Object.freeze({
        path: relativePath,
        preimageSha256: prior?.sha256 ?? null,
        postimageSha256: sha256(buffer),
        bytes: buffer.length,
        preimageArtifact: artifact
      })
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor)
      if (!published) {
        try { fs.unlinkSync(stage) } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
      }
    }
  }

  createFile(relativePath, content) {
    return this.#writeAtomic(relativePath, content, { create: true })
  }

  replaceFile(relativePath, expectedSha256, content) {
    return this.#writeAtomic(relativePath, content, { expected: expectedSha256 })
  }

  moveFile(sourcePath, destinationPath, expectedSha256, semantics) {
    const sameParent = path.posix.dirname(sourcePath) ===
      path.posix.dirname(destinationPath)
    if ((semantics === 'rename') !== sameParent) {
      fail(E3_EDITOR_ERROR.MOVE_SEMANTICS_MISMATCH,
        'rename_file must stay in one directory; move_file must cross directories')
    }
    const source = this.#read(sourcePath, { mutation: true })
    if (source.sha256 !== expectedSha256) {
      fail(E3_EDITOR_ERROR.PREIMAGE_MISMATCH, 'Move preimage does not match')
    }
    this.#assertParents(destinationPath)
    const destination = this.#absolute(destinationPath, true)
    if (fs.existsSync(destination)) {
      fail(E3_EDITOR_ERROR.FILE_EXISTS, 'Move destination already exists')
    }
    const artifact = this.#retain(sourcePath, source)
    this.#guard()
    const current = this.#read(sourcePath, { mutation: true })
    if (current.identity !== source.identity || current.sha256 !== source.sha256) {
      fail(E3_EDITOR_ERROR.PATH_TAMPERED, 'Move source changed')
    }
    if (fs.existsSync(destination)) {
      fail(E3_EDITOR_ERROR.FILE_EXISTS, 'Move destination appeared')
    }
    fs.renameSync(this.#absolute(sourcePath, true), destination)
    for (const directory of new Set([
      path.dirname(this.#absolute(sourcePath, true)),
      path.dirname(destination)
    ])) {
      const fd = fs.openSync(directory, fs.constants.O_RDONLY)
      try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    }
    return Object.freeze({
      sourcePath,
      destinationPath,
      preimageSha256: source.sha256,
      postimageSha256: source.sha256,
      bytes: source.buffer.length,
      preimageArtifact: artifact
    })
  }

  deleteFile(relativePath, expectedSha256) {
    const source = this.#read(relativePath, { mutation: true })
    if (source.sha256 !== expectedSha256) {
      fail(E3_EDITOR_ERROR.PREIMAGE_MISMATCH, 'Delete preimage does not match')
    }
    const artifact = this.#retain(relativePath, source)
    this.#guard()
    const current = this.#read(relativePath, { mutation: true })
    if (current.identity !== source.identity || current.sha256 !== source.sha256) {
      fail(E3_EDITOR_ERROR.PATH_TAMPERED, 'Delete target changed')
    }
    const absolute = this.#absolute(relativePath, true)
    fs.unlinkSync(absolute)
    const fd = fs.openSync(path.dirname(absolute), fs.constants.O_RDONLY)
    try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    return Object.freeze({
      path: relativePath,
      preimageSha256: source.sha256,
      postimageSha256: null,
      bytes: source.buffer.length,
      preimageArtifact: artifact
    })
  }
}
