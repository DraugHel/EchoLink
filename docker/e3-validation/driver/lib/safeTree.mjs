import fs from 'node:fs'
import path from 'node:path'

const MAX_ENTRIES = 100_000
const MAX_BYTES = 512 * 1024 * 1024

function isWithin(root, candidate) {
  return candidate === root ||
    candidate.startsWith(`${root}${path.sep}`)
}

function canonicalDirectory(directory, label) {
  const resolved = path.resolve(directory)
  const actual = fs.realpathSync.native(resolved)
  const stat = fs.lstatSync(actual)
  if (
    resolved !== actual ||
    !stat.isDirectory() ||
    stat.isSymbolicLink()
  ) {
    throw new Error(`${label} is not a canonical directory`)
  }
  return actual
}

function validateLink(root, parent, target) {
  if (
    path.isAbsolute(target) ||
    target.includes('\0')
  ) {
    throw new Error('Validation snapshot contains an unsafe symlink')
  }
  const resolved = path.resolve(parent, target)
  if (!isWithin(root, resolved)) {
    throw new Error('Validation snapshot symlink escapes the snapshot')
  }
  const actual = fs.realpathSync.native(resolved)
  if (!isWithin(root, actual)) {
    throw new Error('Validation snapshot symlink target escapes the snapshot')
  }
}

export function copyValidationWorkspace({
  inputRoot,
  workRoot,
  dependencyRoot
}) {
  const input = canonicalDirectory(inputRoot, 'inputRoot')
  const dependencies = canonicalDirectory(
    dependencyRoot,
    'dependencyRoot'
  )
  const work = path.resolve(workRoot)
  if (fs.existsSync(work)) {
    throw new Error('Validation work directory already exists')
  }
  fs.mkdirSync(work, { recursive: true, mode: 0o700 })
  let entries = 0
  let bytes = 0
  const directoryModes = []

  const copy = (source, target) => {
    const name = path.basename(source)
    if (name === '.git' || name === 'node_modules') {
      throw new Error(
        'Validation snapshot contains a forbidden dependency path'
      )
    }
    const stat = fs.lstatSync(source)
    entries += 1
    if (entries > MAX_ENTRIES) {
      throw new Error('Validation snapshot contains too many entries')
    }
    if (stat.isDirectory()) {
      const finalMode = stat.mode & 0o777
      fs.mkdirSync(target, { mode: finalMode | 0o700 })
      for (const childName of fs.readdirSync(source).sort()) {
        copy(
          path.join(source, childName),
          path.join(target, childName)
        )
      }
      directoryModes.push({ target, mode: finalMode })
      return
    }
    if (stat.isSymbolicLink()) {
      const link = fs.readlinkSync(source)
      validateLink(input, path.dirname(source), link)
      fs.symlinkSync(link, target)
      return
    }
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error('Validation snapshot contains an unsupported entry')
    }
    bytes += stat.size
    if (bytes > MAX_BYTES) {
      throw new Error('Validation snapshot exceeds the driver byte limit')
    }
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL)
    fs.chmodSync(target, stat.mode & 0o777)
  }

  try {
    for (const name of fs.readdirSync(input).sort()) {
      copy(path.join(input, name), path.join(work, name))
    }
    const rootModules = path.join(dependencies, 'node_modules')
    const clientModules = path.join(
      dependencies,
      'client/node_modules'
    )
    if (!fs.statSync(rootModules).isDirectory()) {
      throw new Error('Server dependency layer is unavailable')
    }
    if (!fs.statSync(clientModules).isDirectory()) {
      throw new Error('Client dependency layer is unavailable')
    }
    fs.symlinkSync(rootModules, path.join(work, 'node_modules'))
    const clientRoot = path.join(work, 'client')
    if (fs.existsSync(clientRoot)) {
      if (!fs.statSync(clientRoot).isDirectory()) {
        throw new Error('Client source path is not a directory')
      }
      fs.symlinkSync(
        clientModules,
        path.join(clientRoot, 'node_modules')
      )
    }
    for (const directory of directoryModes) {
      fs.chmodSync(directory.target, directory.mode)
    }
    return Object.freeze({
      inputRoot: input,
      workRoot: work,
      entries,
      bytes
    })
  } catch (error) {
    try {
      fs.chmodSync(work, 0o700)
      for (const directory of [...directoryModes].reverse()) {
        if (!fs.existsSync(directory.target)) continue
        const stat = fs.lstatSync(directory.target)
        if (stat.isDirectory() && !stat.isSymbolicLink()) {
          fs.chmodSync(directory.target, 0o700)
        }
      }
      fs.rmSync(work, { recursive: true, force: true })
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Validation workspace preparation and cleanup failed'
      )
    }
    throw error
  }
}

export function listFiles(rootDirectory, predicate = () => true) {
  const root = canonicalDirectory(rootDirectory, 'rootDirectory')
  const files = []
  const visit = current => {
    for (const name of fs.readdirSync(current).sort()) {
      if (name === 'node_modules' || name === 'dist') continue
      const absolute = path.join(current, name)
      const stat = fs.lstatSync(absolute)
      if (stat.isDirectory()) visit(absolute)
      else if (stat.isFile() && predicate(absolute)) files.push(absolute)
    }
  }
  visit(root)
  return Object.freeze(files)
}
