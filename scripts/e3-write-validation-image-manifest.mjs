#!/usr/bin/env node
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createValidationImageManifest,
  serializeValidationImageManifest,
  validationDriverSourceSha256
} from '../server/e3/validation/imageManifest.js'

function sha256(file) {
  return createHash('sha256')
    .update(fs.readFileSync(file))
    .digest('hex')
}

function main() {
  if (process.argv.length !== 11) {
    throw new Error('Validation image manifest writer arguments are invalid')
  }
  const [
    outputPath,
    sourceHead,
    sourceTreeGitSha,
    sourceTreeSha256,
    nodeImageDigest,
    playwrightImageDigest,
    nodeImageTag,
    playwrightImageTag,
    sourceRoot
  ] = process.argv.slice(2)
  const scriptRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..'
  )
  const root = path.resolve(sourceRoot)
  const actualRoot = fs.realpathSync.native(root)
  if (
    root !== actualRoot ||
    !root.startsWith('/tmp/e3-validation-images.') ||
    !fs.statSync(root).isDirectory()
  ) {
    throw new Error('Validation image source root is not builder-owned')
  }
  if (validationDriverSourceSha256(scriptRoot).length !== 64) {
    throw new Error('Validation manifest writer module integrity failed')
  }
  const manifest = createValidationImageManifest({
    builtAt: Date.now(),
    sourceHead,
    sourceTreeGitSha,
    sourceTreeSha256,
    rootLockSha256: sha256(path.join(root, 'package-lock.json')),
    clientLockSha256: sha256(
      path.join(root, 'client/package-lock.json')
    ),
    driverLockSha256: sha256(path.join(
      root,
      'docker/e3-validation/driver/package-lock.json'
    )),
    driverSourceSha256: validationDriverSourceSha256(root),
    nodeImageDigest,
    playwrightImageDigest,
    nodeImageTag,
    playwrightImageTag
  })
  const resolved = path.resolve(outputPath)
  fs.mkdirSync(path.dirname(resolved), {
    recursive: true,
    mode: 0o750
  })
  const temporary = `${resolved}.tmp-${process.pid}`
  fs.writeFileSync(
    temporary,
    serializeValidationImageManifest(manifest),
    { mode: 0o640, flag: 'wx' }
  )
  fs.chmodSync(temporary, 0o640)
  fs.renameSync(temporary, resolved)
  process.stdout.write(`${manifest.manifestSha256}\n`)
}

try {
  main()
} catch (error) {
  process.stderr.write(`${error?.stack ?? String(error)}\n`)
  process.exitCode = 1
}
