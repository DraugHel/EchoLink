import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import {
  DRIVER_PROFILE,
  childEnvironment,
  validateDriverInvocation
} from '../docker/e3-validation/driver/lib/contracts.mjs'
import {
  assertTextHygiene,
  fixturePath
} from '../docker/e3-validation/driver/lib/profiles.mjs'
import {
  copyValidationWorkspace
} from '../docker/e3-validation/driver/lib/safeTree.mjs'
import {
  createValidationImageManifest,
  loadValidationImageManifest,
  parseValidationImageManifest,
  serializeValidationImageManifest,
  validationDriverSourceSha256
} from '../server/e3/validation/imageManifest.js'
import {
  E3_NODE_VALIDATION_BASE,
  E3_PLAYWRIGHT_VALIDATION_BASE
} from '../server/e3/validation/imageSources.js'

const SESSION_ID = '11111111-1111-4111-8111-111111111111'
const RUN_ID = '22222222-2222-4222-8222-222222222222'
const SHA = 'a'.repeat(64)

function environment(profileId = DRIVER_PROFILE.DIFF_CHECK) {
  return {
    E3_RUN_ID: RUN_ID,
    E3_SESSION_ID: SESSION_ID,
    E3_SNAPSHOT_HANDLE: 'snapshot-handle',
    E3_CANDIDATE_MANIFEST_SHA256: SHA,
    E3_PROFILE_ID: profileId,
    E3_PROFILE_SHA256: SHA
  }
}

const IS_ROOT =
  typeof process.getuid === 'function' &&
  process.getuid() === 0

function removeFixtureTree(root) {
  if (!fs.existsSync(root)) return

  const makeWritable = current => {
    const stat = fs.lstatSync(current)

    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink()
    ) {
      return
    }

    fs.chmodSync(current, 0o700)

    for (const name of fs.readdirSync(current)) {
      makeWritable(path.join(current, name))
    }
  }

  makeWritable(root)
  fs.rmSync(root, {
    recursive: true,
    force: true
  })
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e3-driver-test-'))
  t.after(() => removeFixtureTree(root))
  const inputRoot = path.join(root, 'input')
  const dependencyRoot = path.join(root, 'dependencies')
  const workRoot = path.join(root, 'work')
  fs.mkdirSync(path.join(inputRoot, 'client'), { recursive: true })
  fs.mkdirSync(path.join(dependencyRoot, 'node_modules'), {
    recursive: true
  })
  fs.mkdirSync(path.join(dependencyRoot, 'client/node_modules'), {
    recursive: true
  })
  fs.writeFileSync(path.join(inputRoot, 'app.js'), 'export const ok = true\n')
  fs.writeFileSync(
    path.join(inputRoot, 'client/index.html'),
    '<!doctype html>\n'
  )
  return { root, inputRoot, dependencyRoot, workRoot }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

test('driver accepts only the exact fixed invocation envelope', () => {
  const valid = validateDriverInvocation(
    DRIVER_PROFILE.DIFF_CHECK,
    environment()
  )
  assert.equal(valid.profileId, DRIVER_PROFILE.DIFF_CHECK)
  assert.throws(
    () => validateDriverInvocation('shell:anything', environment()),
    /Unknown E3 validation driver profile/
  )
  assert.throws(
    () => validateDriverInvocation(
      DRIVER_PROFILE.TEST_FULL,
      environment(DRIVER_PROFILE.DIFF_CHECK)
    ),
    /does not match/
  )
  assert.throws(
    () => validateDriverInvocation(
      DRIVER_PROFILE.DIFF_CHECK,
      { ...environment(), E3_TEST_ORIGIN: 'http://e3-app:4173' }
    ),
    /forbidden/
  )
})

test('child environment drops unrelated production values', () => {
  const result = childEnvironment({
    ...environment(),
    OPENAI_API_KEY: 'sentinel-secret',
    DATABASE_URL: '/root/echolink/data/echolink.db'
  })
  assert.equal(result.OPENAI_API_KEY, undefined)
  assert.equal(result.DATABASE_URL, undefined)
  assert.equal(result.HOME, '/e3/empty-home')
  assert.equal(result.TMPDIR, '/e3/tmp')
})

test('workspace copy is bounded and injects only trusted dependencies', t => {
  const item = fixture(t)
  const result = copyValidationWorkspace(item)
  assert.equal(fs.readFileSync(
    path.join(result.workRoot, 'app.js'),
    'utf8'
  ), 'export const ok = true\n')
  assert.equal(fs.lstatSync(
    path.join(result.workRoot, 'node_modules')
  ).isSymbolicLink(), true)
  assert.equal(fs.lstatSync(
    path.join(result.workRoot, 'client/node_modules')
  ).isSymbolicLink(), true)
})


test('workspace copy populates nested read-only source directories', t => {
  const item = fixture(t)
  const workflows = path.join(item.inputRoot, '.github/workflows')
  fs.mkdirSync(workflows, { recursive: true })
  fs.writeFileSync(path.join(workflows, 'ci.yml'), 'name: CI\n')
  fs.chmodSync(workflows, 0o555)
  fs.chmodSync(path.dirname(workflows), 0o555)
  fs.chmodSync(path.join(item.inputRoot, 'client'), 0o555)

  const result = copyValidationWorkspace(item)
  const copiedGithub = path.join(result.workRoot, '.github')
  const copiedWorkflows = path.join(copiedGithub, 'workflows')

  assert.equal(
    fs.readFileSync(path.join(copiedWorkflows, 'ci.yml'), 'utf8'),
    'name: CI\n'
  )
  assert.equal(fs.statSync(copiedGithub).mode & 0o777, 0o555)
  assert.equal(fs.statSync(copiedWorkflows).mode & 0o777, 0o555)
  assert.equal(
    fs.lstatSync(
      path.join(result.workRoot, 'client/node_modules')
    ).isSymbolicLink(),
    true
  )
  assert.equal(
    fs.statSync(path.join(result.workRoot, 'client')).mode & 0o777,
    0o555
  )
})

test('workspace copy rejects dependency paths and escaping symlinks', t => {
  const dependency = fixture(t)
  fs.mkdirSync(path.join(dependency.inputRoot, 'node_modules'))
  assert.throws(
    () => copyValidationWorkspace(dependency),
    /forbidden dependency path/
  )

  const link = fixture(t)
  fs.symlinkSync('../../outside', path.join(link.inputRoot, 'escape'))
  assert.throws(
    () => copyValidationWorkspace(link),
    /symlink escapes/
  )
})

test('diff hygiene rejects trailing whitespace and conflict markers', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e3-diff-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'clean.js'), 'const ok = true\n')
  assert.doesNotThrow(() => assertTextHygiene(root))
  fs.writeFileSync(path.join(root, 'bad.js'), 'const bad = true  \n')
  assert.throws(() => assertTextHygiene(root), /trailing whitespace/)
  fs.writeFileSync(path.join(root, 'bad.js'), '<<<<<<< HEAD\n')
  assert.throws(() => assertTextHygiene(root), /conflict marker/)
})

test('UI fixture path stays inside the fixed root', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e3-ui-path-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  assert.equal(fixturePath(root, '/'), path.join(root, 'index.html'))
  assert.equal(fixturePath(root, '/%2e%2e/secret'), null)
})

test('image source policy pins exact immutable upstream manifests', () => {
  assert.equal(
    E3_NODE_VALIDATION_BASE.reference,
    'node:24.18.0-bookworm-slim@sha256:' +
      '6f7b03f7c2c8e2e784dcf9295400527b' +
      '9b1270fd37b7e9a7285cf83b6951452d'
  )
  assert.equal(
    E3_PLAYWRIGHT_VALIDATION_BASE.reference,
    'mcr.microsoft.com/playwright:v1.61.1-noble@sha256:' +
      '5b8f294aff9041b7191c34a4bab3ac27' +
      '0157a28774d4b0660e9743297b697e48'
  )
})

test('image manifest is canonical, hash-bound and tamper evident', () => {
  const input = {
    builtAt: 123,
    sourceHead: '1'.repeat(40),
    sourceTreeGitSha: '2'.repeat(40),
    sourceTreeSha256: '3'.repeat(64),
    rootLockSha256: '4'.repeat(64),
    clientLockSha256: '5'.repeat(64),
    driverLockSha256: '6'.repeat(64),
    driverSourceSha256: '7'.repeat(64),
    nodeImageDigest: `sha256:${'8'.repeat(64)}`,
    playwrightImageDigest: `sha256:${'9'.repeat(64)}`,
    nodeImageTag: 'echolink-e3-node-validator:tree',
    playwrightImageTag: 'echolink-e3-playwright-validator:tree'
  }
  const manifest = createValidationImageManifest(input)
  const bytes = serializeValidationImageManifest(manifest)
  assert.deepEqual(parseValidationImageManifest(bytes), manifest)
  const tampered = JSON.parse(bytes)
  tampered.runtimeVersion = '22.0.0'
  assert.throws(
    () => parseValidationImageManifest(JSON.stringify(tampered)),
    /source policy/
  )
})

test(
  'durable image manifest must be canonical root-owned 0640',
  {
    skip: IS_ROOT
      ? false
      : 'requires a root-owned filesystem fixture'
  },
  t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e3-image-manifest-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const manifestPath = path.join(root, 'validation-images.json')
  const manifest = createValidationImageManifest({
    builtAt: 123,
    sourceHead: '1'.repeat(40),
    sourceTreeGitSha: '2'.repeat(40),
    sourceTreeSha256: '3'.repeat(64),
    rootLockSha256: '4'.repeat(64),
    clientLockSha256: '5'.repeat(64),
    driverLockSha256: '6'.repeat(64),
    driverSourceSha256: '7'.repeat(64),
    nodeImageDigest: `sha256:${'8'.repeat(64)}`,
    playwrightImageDigest: `sha256:${'9'.repeat(64)}`,
    nodeImageTag: 'echolink-e3-node-validator:tree',
    playwrightImageTag: 'echolink-e3-playwright-validator:tree'
  })
  fs.writeFileSync(
    manifestPath,
    serializeValidationImageManifest(manifest),
    { mode: 0o640 }
  )
  fs.chmodSync(manifestPath, 0o640)
  assert.equal(
    loadValidationImageManifest({ manifestPath }).manifestSha256,
    manifest.manifestSha256
  )
  fs.chmodSync(manifestPath, 0o644)
  assert.throws(
    () => loadValidationImageManifest({ manifestPath }),
    /file is unsafe/
  )
})

test(
  'manifest writer enforces 0640 under restrictive umask',
  {
    skip: IS_ROOT
      ? false
      : 'requires the root-owned builder environment'
  },
  t => {
  const projectRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..'
  )
  const sourceRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'e3-validation-images.')
  )
  t.after(() => fs.rmSync(sourceRoot, { recursive: true, force: true }))
  fs.mkdirSync(path.join(sourceRoot, 'client'), { recursive: true })
  fs.mkdirSync(
    path.join(sourceRoot, 'docker/e3-validation'),
    { recursive: true }
  )
  fs.copyFileSync(
    path.join(projectRoot, 'package-lock.json'),
    path.join(sourceRoot, 'package-lock.json')
  )
  fs.copyFileSync(
    path.join(projectRoot, 'client/package-lock.json'),
    path.join(sourceRoot, 'client/package-lock.json')
  )
  fs.cpSync(
    path.join(projectRoot, 'docker/e3-validation/driver'),
    path.join(sourceRoot, 'docker/e3-validation/driver'),
    { recursive: true }
  )
  const outputPath = path.join(sourceRoot, 'validation-images.json')
  const writerPath = path.join(
    projectRoot,
    'scripts/e3-write-validation-image-manifest.mjs'
  )
  const helperPath = path.join(sourceRoot, 'run-writer.mjs')
  const args = [
    outputPath,
    '1'.repeat(40),
    '2'.repeat(40),
    '3'.repeat(64),
    `sha256:${'4'.repeat(64)}`,
    `sha256:${'5'.repeat(64)}`,
    'echolink-e3-node-validator:tree',
    'echolink-e3-playwright-validator:tree',
    sourceRoot
  ]
  fs.writeFileSync(
    helperPath,
    `process.umask(0o077)\n` +
      `process.argv = ${JSON.stringify([process.execPath, writerPath, ...args])}\n` +
      `await import(${JSON.stringify(pathToFileURL(writerPath).href)})\n`
  )
  const result = spawnSync(process.execPath, [helperPath], {
    encoding: 'utf8'
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(fs.statSync(outputPath).mode & 0o777, 0o640)
  assert.match(
    loadValidationImageManifest({ manifestPath: outputPath }).manifestSha256,
    /^[0-9a-f]{64}$/
  )
})

test('driver source digest changes with bytes, not file order', () => {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..'
  )
  const actual = validationDriverSourceSha256(root)
  assert.match(actual, /^[0-9a-f]{64}$/)
  assert.notEqual(actual, sha256(''))
})

test('Dockerfiles and builder contain no caller-selected image path', () => {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..'
  )
  const nodeDockerfile = fs.readFileSync(
    path.join(root, 'docker/e3-validation/node.Dockerfile'),
    'utf8'
  )
  const playwrightDockerfile = fs.readFileSync(
    path.join(root, 'docker/e3-validation/playwright.Dockerfile'),
    'utf8'
  )
  const builder = fs.readFileSync(
    path.join(root, 'scripts/e3-build-validation-images.sh'),
    'utf8'
  )
  const driverLock = JSON.parse(fs.readFileSync(
    path.join(root, 'docker/e3-validation/driver/package-lock.json'),
    'utf8'
  ))
  assert.equal(
    driverLock.packages['node_modules/playwright-core'].version,
    '1.61.1'
  )
  for (const dockerfile of [nodeDockerfile, playwrightDockerfile]) {
    assert.doesNotMatch(dockerfile, /^ARG .*BASE/m)
    assert.match(dockerfile, /USER 65532:65532/)
    assert.match(dockerfile, /@sha256:[0-9a-f]{64}/)
    assert.match(
      dockerfile,
      /\/opt\/echolink\/validation-driver\.mjs/
    )
  }
  assert.match(
    nodeDockerfile,
    /apt-get install[\s\S]*--no-install-recommends git/
  )
  assert.match(builder, /GIT_INDEX_FILE/)
  assert.match(builder, /git checkout-index/)
  assert.match(builder, /E3_VALIDATION_IMAGES_BUILD_AND_SMOKE_SUCCESS/)
  assert.match(builder, /"\$CONTEXT_ROOT"/)
  assert.match(builder, /chmod 0555/)
  assert.match(builder, /chmod 0444/)
  assert.match(builder, /Docker-Daemon ist nicht erreichbar/)
  assert.match(builder, /Bestehende E3-Validator-Images/)
  assert.match(builder, /E3-Image-Speicher existiert bereits/)
  assert.match(builder, /Symlink im Build-Kontext/)
  assert.doesNotMatch(builder, /docker system prune|git clean|rm -rf \/var\/lib/)
})
