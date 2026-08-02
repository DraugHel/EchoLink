#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  E3_OPERATIONAL_PILOT_CASES,
  E3_OPERATIONAL_PILOT_NEGATIVE_CASES,
  E3_OPERATIONAL_PILOT_POSITIVE_CASES,
  createOperationalPilotAdapter,
  parseOperationalPilotArgs,
  readCanonicalPilotManifest,
  runOperationalPilot
} from '../server/e3/pilot/operationalPilot.js'

const REPOSITORY_ROOT = '/root/echolink'
const GIT = '/usr/bin/git'
const DOCKER = '/usr/bin/docker'
const PILOT_FLAG = 'E3_PILOT_HARNESS_ENABLED'
const ALLOWED_DIRTY_PATHS = Object.freeze([
  'scripts/e3-operational-pilot.mjs',
  'server/e3/pilot/interruptionPilot.js',
  'server/e3/pilot/operationalPilot.js',
  'tests/e3InterruptionPilot.test.mjs',
  'tests/e3OperationalPilot.test.mjs'
])
const MAX_BUFFER = 256 * 1024 * 1024

function fixedEnvironment(home = REPOSITORY_ROOT) {
  return {
    PATH: '/usr/bin:/bin',
    HOME: home,
    LC_ALL: 'C',
    LANG: 'C',
    TZ: 'UTC',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/bin/false',
    GIT_OPTIONAL_LOCKS: '0'
  }
}

function fixedCommand(executable, args, {
  cwd = REPOSITORY_ROOT,
  encoding = 'utf8'
} = {}) {
  return execFileSync(executable, args, {
    cwd,
    encoding,
    maxBuffer: MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: fixedEnvironment(cwd)
  })
}

function git(args, encoding = 'utf8') {
  return fixedCommand(GIT, args, { encoding })
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

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
  return Buffer.from(`${JSON.stringify(canonical(value), null, 2)}\n`)
}

function assertOperatorBoundary() {
  if (process.getuid?.() !== 0) {
    throw new Error('Operational pilot requires the root operator identity')
  }
  if (process.env[PILOT_FLAG] !== 'true') {
    throw new Error(
      `${PILOT_FLAG}=true is required for this one operator invocation`
    )
  }
  if (resolve(process.cwd()) !== REPOSITORY_ROOT) {
    process.chdir(REPOSITORY_ROOT)
  }
  const branch = git(['branch', '--show-current']).trim()
  if (branch !== 'main') {
    throw new Error('Operational pilot requires branch main')
  }
  const lines = git([
    'status',
    '--short',
    '--untracked-files=normal'
  ]).split('\n').filter(Boolean)
  if (lines.length === 0) return
  const actual = [...new Set(lines.map(line => line.slice(3)))].sort()
  const expected = [...ALLOWED_DIRTY_PATHS].sort()
  if (
    actual.length !== expected.length ||
    actual.some((path, index) => path !== expected[index])
  ) {
    throw new Error('Operational pilot working-tree scope is not approved')
  }
  for (const line of lines) {
    if (!line.startsWith(' M ') && !line.startsWith('?? ')) {
      throw new Error('Operational pilot rejects staged or unusual Git state')
    }
  }
}

function repositoryFingerprint() {
  const digest = createHash('sha256')
  digest.update(git(['rev-parse', 'HEAD'], null))
  digest.update(git([
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all'
  ], null))
  digest.update(git(['diff', '--binary', 'HEAD', '--'], null))
  const untracked = git([
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z'
  ], null).toString('utf8').split('\0').filter(Boolean).sort()
  for (const repositoryPath of untracked) {
    const absolute = resolve(REPOSITORY_ROOT, repositoryPath)
    const relation = relative(REPOSITORY_ROOT, absolute)
    if (
      relation === '' ||
      relation === '..' ||
      relation.startsWith('../')
    ) {
      throw new Error('Untracked path escaped the repository')
    }
    const metadata = lstatSync(absolute)
    digest.update(repositoryPath)
    digest.update('\0')
    digest.update(String(metadata.mode & 0o7777))
    digest.update('\0')
    if (metadata.isSymbolicLink()) {
      digest.update(readlinkSync(absolute))
    } else if (metadata.isFile()) {
      digest.update(readFileSync(absolute))
    } else {
      throw new Error('Unsupported untracked repository entry')
    }
  }
  return digest.digest('hex')
}

function directoryFingerprint(root) {
  const digest = createHash('sha256')
  const visit = current => {
    for (const name of readdirSync(current).sort()) {
      const absolute = join(current, name)
      const repositoryPath = relative(root, absolute).replaceAll('\\', '/')
      const metadata = lstatSync(absolute)
      digest.update(repositoryPath)
      digest.update('\0')
      digest.update(String(metadata.mode & 0o7777))
      digest.update('\0')
      if (metadata.isDirectory()) {
        visit(absolute)
      } else if (metadata.isSymbolicLink()) {
        digest.update(readlinkSync(absolute))
      } else if (metadata.isFile()) {
        digest.update(readFileSync(absolute))
      } else {
        throw new Error('Unsupported entry in fingerprinted directory')
      }
    }
  }
  visit(root)
  return digest.digest('hex')
}

function dockerInventory() {
  const containers = fixedCommand(DOCKER, [
    'ps',
    '-a',
    '--filter',
    'label=echolink.e3.run',
    '--format',
    '{{.ID}} {{.Names}} {{.Status}}'
  ], { cwd: '/' }).trim().split('\n').filter(Boolean).sort()
  const networks = fixedCommand(DOCKER, [
    'network',
    'ls',
    '--filter',
    'label=echolink.e3.run',
    '--format',
    '{{.ID}} {{.Name}}'
  ], { cwd: '/' }).trim().split('\n').filter(Boolean).sort()
  return Object.freeze({ containers, networks })
}

function equalInventory(first, second) {
  return JSON.stringify(first) === JSON.stringify(second)
}

export async function main(argv = process.argv.slice(2)) {
  assertOperatorBoundary()
  const cases = parseOperationalPilotArgs(argv)
  const baselineCommit = git(['rev-parse', 'HEAD']).trim()
  const manifest = readCanonicalPilotManifest({
    expectedBaseline: baselineCommit
  })
  const pilotRoot = mkdtempSync(
    join(tmpdir(), 'echolink-e3-operational-pilot-')
  )
  chmodSync(pilotRoot, 0o700)
  const repositoryBefore = repositoryFingerprint()
  const distBefore = directoryFingerprint(join(REPOSITORY_ROOT, 'dist'))
  const dockerBefore = dockerInventory()
  let completed = false
  try {
    const result = await runOperationalPilot({
      cases,
      pilotRoot,
      baselineCommit,
      manifest,
      adapters: createOperationalPilotAdapter()
    })
    if (result.result !== 'READY') {
      throw new Error('Operational pilot retained a failed case')
    }
    const summaryBytes = readFileSync(result.resultPath)
    if (sha256(summaryBytes) !== result.summarySha256) {
      throw new Error('Operational pilot summary hash mismatch')
    }
    if (
      readdirSync(pilotRoot).sort().join('\n') !== 'pilot-summary.json'
    ) {
      throw new Error('Operational pilot root contains unexpected resources')
    }
    const repositoryAfter = repositoryFingerprint()
    const distAfter = directoryFingerprint(join(REPOSITORY_ROOT, 'dist'))
    const dockerAfter = dockerInventory()
    if (repositoryAfter !== repositoryBefore) {
      throw new Error('Operational pilot changed the repository')
    }
    if (distAfter !== distBefore) {
      throw new Error('Operational pilot changed the productive frontend build')
    }
    if (!equalInventory(dockerAfter, dockerBefore)) {
      throw new Error('Operational pilot did not restore Docker resources')
    }
    const positiveCatalog = (
      cases.length === E3_OPERATIONAL_PILOT_POSITIVE_CASES.length &&
      cases.every((name, index) =>
        name === E3_OPERATIONAL_PILOT_POSITIVE_CASES[index]
      )
    )
    const negativeCatalog = (
      cases.length === E3_OPERATIONAL_PILOT_NEGATIVE_CASES.length &&
      cases.every((name, index) =>
        name === E3_OPERATIONAL_PILOT_NEGATIVE_CASES[index]
      )
    )
    const fullCatalog = (
      cases.length === E3_OPERATIONAL_PILOT_CASES.length &&
      cases.every((name, index) => name === E3_OPERATIONAL_PILOT_CASES[index])
    )
    const attestation = {
      format: 'echolink-e3-operational-pilot-attestation-v1',
      result: fullCatalog
        ? 'IMPLEMENTATION_READY'
        : positiveCatalog
          ? 'POSITIVE_CATALOG_COMPLETED'
          : negativeCatalog
            ? 'NEGATIVE_CATALOG_COMPLETED'
            : 'CASE_COMPLETED',
      baselineCommit,
      manifestSha256: manifest.manifestSha256,
      imageDigests: {
        node: manifest.nodeImageDigest,
        playwright: manifest.playwrightImageDigest
      },
      cases: result.cases.map(item => ({
        name: item.name,
        expectedOutcome: item.expectedOutcome,
        actualOutcome: item.actualOutcome,
        sessionEndState: item.sessionEndState,
        exportSha256: item.exportSha256,
        rejectionCode: item.rejectionCode
      })),
      summarySha256: result.summarySha256,
      repositoryFingerprint: repositoryAfter,
      distFingerprint: distAfter,
      dockerInventorySha256: sha256(canonicalJson(dockerAfter)),
      completedAt: new Date().toISOString()
    }
    const attestationBytes = canonicalJson(attestation)
    const attestationPath = join(pilotRoot, 'pilot-attestation.json')
    writeFileSync(attestationPath, attestationBytes, {
      mode: 0o600,
      flag: 'wx'
    })
    const finalEntries = readdirSync(pilotRoot).sort()
    if (
      finalEntries.length !== 2 ||
      finalEntries[0] !== 'pilot-attestation.json' ||
      finalEntries[1] !== 'pilot-summary.json'
    ) {
      throw new Error('Operational pilot evidence inventory is incomplete')
    }
    completed = true
    console.log(JSON.stringify({
      result: attestation.result,
      pilotRoot,
      summaryPath: result.resultPath,
      summarySha256: result.summarySha256,
      attestationPath,
      attestationSha256: sha256(attestationBytes),
      cases: attestation.cases
    }))
    console.log('E3_STEP14A2_OPERATIONAL_PILOT_SUCCESS')
    if (positiveCatalog) {
      console.log('E3_STEP14A3_POSITIVE_OPERATIONAL_PILOT_SUCCESS')
    }
    if (negativeCatalog) {
      console.log('E3_STEP14A4_NEGATIVE_OPERATIONAL_PILOT_SUCCESS')
    }
    if (fullCatalog) {
      console.log('E3_STEP14A2_IMPLEMENTATION_READY')
    }
  } finally {
    if (!completed) {
      console.error(`DIAGNOSTIC_ROOT=${pilotRoot}`)
    }
  }
}

const direct = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  : false

if (direct) {
  main().catch(error => {
    console.error(`${error.name}: ${error.message}`)
    process.exitCode = 1
  })
}
