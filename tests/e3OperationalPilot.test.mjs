import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  CANONICAL_MANIFEST,
  E3_OPERATIONAL_PILOT_CASES,
  E3_OPERATIONAL_PILOT_PROFILES,
  E3_OPERATIONAL_PILOT_INVALID_CONTENT,
  E3_OPERATIONAL_PILOT_INVALID_PATH,
  E3_OPERATIONAL_PILOT_SUCCESS_CONTENT,
  E3_OPERATIONAL_PILOT_SUCCESS_PATH,
  E3_OPERATIONAL_PILOT_TAMPER_CONTENT,
  E3_OPERATIONAL_PILOT_TAMPER_PATH,
  assertPilotPathPolicy,
  createOperationalPilotAdapter,
  createOperationalPilotCaseContext,
  createOperationalPilotValidationServices,
  completeOperationalPilotSuccess,
  completeOperationalPilotTamperReject,
  parseOperationalPilotArgs,
  prepareOperationalPilotCandidate,
  readCanonicalPilotManifest,
  runOperationalPilotCase,
  runOperationalPilot,
  runOperationalPilotValidation
} from '../server/e3/pilot/operationalPilot.js'
import {
  E3_VALIDATION_PROFILE_ID
} from '../server/e3/validation/contracts.js'
import {
  E3_REVIEW_ERROR
} from '../server/e3/review/errors.js'

const GIT = '/usr/bin/git'
const manifest = {
  manifestSha256: 'c'.repeat(64),
  nodeImageDigest: `sha256:${'a'.repeat(64)}`,
  playwrightImageDigest: `sha256:${'b'.repeat(64)}`
}

function git(cwd, args) {
  return execFileSync(GIT, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: '/usr/bin:/bin',
      HOME: cwd,
      LC_ALL: 'C',
      LANG: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0'
    }
  }).trim()
}

function createSourceRepository(root) {
  const source = path.join(root, 'source')
  fs.mkdirSync(source)
  git(source, ['init', '--initial-branch=main'])
  git(source, ['config', 'user.name', 'E3 Pilot Test'])
  git(source, ['config', 'user.email', 'e3-pilot@example.invalid'])
  fs.mkdirSync(path.join(source, 'docs'))
  fs.writeFileSync(path.join(source, 'README.md'), '# pilot fixture\n')
  fs.writeFileSync(path.join(source, 'docs', 'baseline.txt'), 'baseline\n')
  git(source, ['add', '--all'])
  git(source, ['commit', '-m', 'baseline'])
  return {
    source,
    baselineCommit: git(source, ['rev-parse', 'HEAD'])
  }
}

function candidateHarness(t, { caseName = 'success' } = {}) {
  const outer = fs.mkdtempSync(
    path.join(os.tmpdir(), 'e3-operational-pilot-test-')
  )
  const source = createSourceRepository(outer)
  const pilotRoot = path.join(
    outer,
    'echolink-e3-operational-pilot-candidate-test'
  )
  fs.mkdirSync(pilotRoot, { mode: 0o700 })
  const context = createOperationalPilotCaseContext({
    pilotRoot,
    caseName,
    baselineCommit: source.baselineCommit,
    repositoryRoot: source.source,
    sourceRepositoryPath: source.source,
    now: () => 10_000
  })
  t.after(() => {
    try {
      context.cleanup()
    } catch {}
    fs.rmSync(outer, { recursive: true, force: true })
  })
  return { outer, pilotRoot, context, ...source }
}

function verifiedCleanup() {
  return {
    snapshots: 'verified',
    outputs: 'verified',
    caseRoot: 'removed',
    database: 'closed'
  }
}

function adapter() {
  return {
    async runCase({ name, profiles }) {
      if (name === 'success') {
        return {
          case: name,
          actualOutcome: 'EXPORTED',
          sessionEndState: 'EXPORTED',
          exportSha256: 'e'.repeat(64),
          patchProof: {
            baselineTree: 'a'.repeat(40),
            candidateTree: 'b'.repeat(40),
            restoredTree: 'a'.repeat(40)
          },
          cleanup: verifiedCleanup(),
          profiles: profiles.map(profileId => ({
            profileId,
            status: 'succeeded'
          }))
        }
      }
      if (name === 'tamper-reject') {
        return {
          case: name,
          actualOutcome: 'TAMPER_REJECTED',
          sessionEndState: 'VALIDATING',
          rejectionCode: E3_REVIEW_ERROR.ARTIFACT_TAMPERED,
          tamperedArtifact: 'candidate-manifest',
          reviewCreated: false,
          approvalCreated: false,
          exportCreated: false,
          cleanup: verifiedCleanup(),
          profiles: profiles.map(profileId => ({
            profileId,
            status: 'succeeded'
          }))
        }
      }
      return {
        case: name,
        actualOutcome: 'VALIDATION_REJECTED',
        sessionEndState: 'VALIDATING',
        rejectionCode: 'DIFF_CHECK_FAILED',
        reviewCreated: false,
        approvalCreated: false,
        exportCreated: false,
        cleanup: verifiedCleanup(),
        profiles: [{ profileId: 'diff:check', status: 'failed' }]
      }
    }
  }
}


test('argument policy is closed', () => {
  assert.deepEqual(
    parseOperationalPilotArgs([]),
    [...E3_OPERATIONAL_PILOT_CASES]
  )
  assert.deepEqual(
    parseOperationalPilotArgs(['--case', 'success']),
    ['success']
  )
  assert.throws(() => parseOperationalPilotArgs(['--case', 'nope']))
  assert.throws(() => parseOperationalPilotArgs(['--root', '/tmp/x']))
})

test('pilot path policy rejects overlap and generic directories', () => {
  assert.throws(() => assertPilotPathPolicy({
    pilotRoot: '/root/echolink/x'
  }))
  assert.throws(() => assertPilotPathPolicy({
    pilotRoot: '/root'
  }))
  assert.throws(() => assertPilotPathPolicy({
    pilotRoot: '/tmp/e3-pilot-x'
  }))
  assert.equal(
    assertPilotPathPolicy({
      pilotRoot: '/tmp/echolink-e3-operational-pilot-x'
    }),
    '/tmp/echolink-e3-operational-pilot-x'
  )
})

test('canonical manifest policy is fail closed', () => {
  const loaded = {
    sourceHead: 'd'.repeat(40),
    manifestSha256: manifest.manifestSha256,
    nodeImageDigest: manifest.nodeImageDigest,
    playwrightImageDigest: manifest.playwrightImageDigest
  }
  let receivedPath = null
  assert.equal(readCanonicalPilotManifest({
    expectedBaseline: 'd'.repeat(40),
    loadManifest: ({ manifestPath }) => {
      receivedPath = manifestPath
      return loaded
    }
  }).sourceHead, 'd'.repeat(40))
  assert.equal(receivedPath, CANONICAL_MANIFEST)
  assert.throws(() => readCanonicalPilotManifest({
    manifestPath: '/tmp/nope',
    expectedBaseline: 'd'.repeat(40),
    loadManifest: () => loaded
  }))
  assert.throws(() => readCanonicalPilotManifest({
    expectedBaseline: 'e'.repeat(40),
    loadManifest: () => loaded
  }))
  assert.equal(CANONICAL_MANIFEST,
    '/var/lib/echolink-e3/validation-images.json')
})

test('real candidate preparation uses private E3 services', t => {
  const h = candidateHarness(t)
  const sourceHeadBefore = git(h.source, ['rev-parse', 'HEAD'])
  const sourceStatusBefore = git(h.source, [
    'status',
    '--porcelain',
    '--untracked-files=all'
  ])

  const result = prepareOperationalPilotCandidate({
    context: h.context
  })

  assert.equal(result.sessionId, h.context.sessionId)
  assert.equal(result.sessionState, 'EDITING')
  assert.match(result.candidateId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.match(result.candidateManifestSha256, /^[0-9a-f]{64}$/)
  assert.match(result.forwardPatchSha256, /^[0-9a-f]{64}$/)
  assert.match(result.reversePatchSha256, /^[0-9a-f]{64}$/)
  assert.match(result.treeSha, /^[0-9a-f]{40}$/)

  const pilotFile = path.join(
    result.workspacePath,
    E3_OPERATIONAL_PILOT_SUCCESS_PATH
  )
  assert.equal(
    fs.readFileSync(pilotFile, 'utf8'),
    E3_OPERATIONAL_PILOT_SUCCESS_CONTENT
  )
  assert.equal(
    fs.existsSync(path.join(
      h.source,
      E3_OPERATIONAL_PILOT_SUCCESS_PATH
    )),
    false
  )
  assert.equal(git(h.source, ['rev-parse', 'HEAD']), sourceHeadBefore)
  assert.equal(git(h.source, [
    'status',
    '--porcelain',
    '--untracked-files=all'
  ]), sourceStatusBefore)

  assert.equal(h.context.database.prepare(
    'SELECT COUNT(*) AS count FROM editor_sessions'
  ).get().count, 1)
  assert.equal(h.context.database.prepare(
    'SELECT COUNT(*) AS count FROM editor_operations'
  ).get().count, 1)
  assert.equal(h.context.database.prepare(
    'SELECT COUNT(*) AS count FROM editor_artifacts'
  ).get().count, 5)
  assert.equal(h.context.database.prepare(
    'SELECT COUNT(*) AS count FROM editor_candidate_artifact_sets'
  ).get().count, 1)
})


function boundManifest(baseCommit) {
  return Object.freeze({
    sourceHead: baseCommit,
    manifestSha256: 'c'.repeat(64),
    nodeImageDigest: `sha256:${'a'.repeat(64)}`,
    playwrightImageDigest: `sha256:${'b'.repeat(64)}`
  })
}

function treeHasTrailingWhitespace(root) {
  const visit = current => {
    for (const name of fs.readdirSync(current)) {
      const absolute = path.join(current, name)
      const stat = fs.lstatSync(absolute)
      if (stat.isDirectory()) {
        if (visit(absolute)) return true
        continue
      }
      if (!stat.isFile()) continue
      const bytes = fs.readFileSync(absolute)
      if (bytes.includes(0)) continue
      for (const line of bytes.toString('utf8').split('\n')) {
        const clean = line.endsWith('\r') ? line.slice(0, -1) : line
        if (/[ \t]+$/.test(clean)) return true
      }
    }
    return false
  }
  return visit(root)
}

function inspectingRuntime() {
  const calls = []
  return {
    calls,
    run(plan, snapshot) {
      const rejected = (
        plan.profile.id === E3_VALIDATION_PROFILE_ID.DIFF_CHECK &&
        treeHasTrailingWhitespace(snapshot.path)
      )
      calls.push({
        profileId: plan.profile.id,
        imageDigest: plan.profile.imageDigest,
        networkMode: plan.isolation.networkMode,
        rejected
      })
      return {
        status: rejected ? 'failed' : 'succeeded',
        exitCode: rejected ? 1 : 0,
        signal: null,
        stdout: rejected ? '' : `${plan.profile.id} ok\n`,
        stderr: rejected ? 'trailing whitespace\n' : '',
        outputBytes: 0
      }
    }
  }
}

test('success candidate traverses real broker and all fixed profiles', t => {
  const h = candidateHarness(t)
  const candidate = prepareOperationalPilotCandidate({ context: h.context })
  const runtime = inspectingRuntime()
  const services = createOperationalPilotValidationServices({
    context: h.context,
    candidate,
    manifest: boundManifest(h.baselineCommit),
    runtime
  })
  assert.equal(services.resolvedCandidate.id, candidate.candidateId)
  const result = runOperationalPilotValidation({
    context: h.context,
    candidate,
    manifest: boundManifest(h.baselineCommit),
    runtime
  })
  assert.equal(result.actualOutcome, 'VALIDATED')
  assert.equal(result.sessionState, 'VALIDATING')
  assert.equal(result.profiles.every(item =>
    typeof item.evidenceId === 'string'
  ), true)
  assert.equal(h.context.database.prepare(`
    SELECT COUNT(*) AS count FROM editor_validation_evidence
  `).get().count, E3_OPERATIONAL_PILOT_PROFILES.length)
  assert.deepEqual(
    result.profiles.map(item => item.profileId),
    [...E3_OPERATIONAL_PILOT_PROFILES]
  )
  assert.equal(result.profiles.every(item => item.status === 'succeeded'), true)
  assert.equal(runtime.calls.length, E3_OPERATIONAL_PILOT_PROFILES.length)
  assert.equal(
    runtime.calls.find(call =>
      call.profileId === E3_VALIDATION_PROFILE_ID.PLAYWRIGHT_UI
    ).imageDigest,
    boundManifest(h.baselineCommit).playwrightImageDigest
  )
  assert.equal(
    runtime.calls.filter(call =>
      call.profileId !== E3_VALIDATION_PROFILE_ID.PLAYWRIGHT_UI
    ).every(call =>
      call.imageDigest === boundManifest(h.baselineCommit).nodeImageDigest
    ),
    true
  )
  assert.deepEqual(result.cleanup, {
    snapshots: 'verified',
    outputs: 'verified'
  })
})

test('validation-reject is caused by real trailing whitespace bytes', t => {
  const h = candidateHarness(t, { caseName: 'validation-reject' })
  const candidate = prepareOperationalPilotCandidate({ context: h.context })
  assert.equal(candidate.mutationPath, E3_OPERATIONAL_PILOT_INVALID_PATH)
  assert.equal(
    fs.readFileSync(path.join(
      candidate.workspacePath,
      E3_OPERATIONAL_PILOT_INVALID_PATH
    ), 'utf8'),
    E3_OPERATIONAL_PILOT_INVALID_CONTENT
  )
  const runtime = inspectingRuntime()
  const result = runOperationalPilotValidation({
    context: h.context,
    candidate,
    manifest: boundManifest(h.baselineCommit),
    runtime
  })
  assert.equal(result.actualOutcome, 'VALIDATION_REJECTED')
  assert.equal(result.profiles.length, 1)
  assert.equal(result.profiles[0].profileId, 'diff:check')
  assert.equal(result.profiles[0].status, 'failed')
  assert.equal(runtime.calls[0].rejected, true)
})

test('tamper-reject validates fully then blocks review, approval and export', t => {
  const h = candidateHarness(t, { caseName: 'tamper-reject' })
  const sourceHeadBefore = git(h.source, ['rev-parse', 'HEAD'])
  const sourceStatusBefore = git(h.source, [
    'status',
    '--porcelain',
    '--untracked-files=all'
  ])
  const candidate = prepareOperationalPilotCandidate({ context: h.context })
  assert.equal(candidate.mutationPath, E3_OPERATIONAL_PILOT_TAMPER_PATH)
  assert.equal(
    fs.readFileSync(path.join(
      candidate.workspacePath,
      E3_OPERATIONAL_PILOT_TAMPER_PATH
    ), 'utf8'),
    E3_OPERATIONAL_PILOT_TAMPER_CONTENT
  )
  const runtime = inspectingRuntime()
  const validation = runOperationalPilotValidation({
    context: h.context,
    candidate,
    manifest: boundManifest(h.baselineCommit),
    runtime
  })
  assert.equal(validation.actualOutcome, 'VALIDATED')
  assert.equal(validation.profiles.length, E3_OPERATIONAL_PILOT_PROFILES.length)
  assert.equal(validation.profiles.every(item => item.status === 'succeeded'), true)

  const result = completeOperationalPilotTamperReject({
    context: h.context,
    candidate,
    validation
  })

  assert.equal(result.actualOutcome, 'TAMPER_REJECTED')
  assert.equal(result.sessionEndState, 'VALIDATING')
  assert.equal(result.tamperedArtifact, 'candidate-manifest')
  assert.equal(result.rejectionCode, E3_REVIEW_ERROR.ARTIFACT_TAMPERED)
  assert.equal(result.reviewCreated, false)
  assert.equal(result.approvalCreated, false)
  assert.equal(result.exportCreated, false)
  assert.deepEqual(result.databaseCounts, {
    validationEvidence: E3_OPERATIONAL_PILOT_PROFILES.length,
    reviewSets: 0,
    approvalRecords: 0,
    exportRecords: 0
  })
  assert.equal(runtime.calls.length, E3_OPERATIONAL_PILOT_PROFILES.length)
  assert.equal(git(h.source, ['rev-parse', 'HEAD']), sourceHeadBefore)
  assert.equal(git(h.source, [
    'status',
    '--porcelain',
    '--untracked-files=all'
  ]), sourceStatusBefore)
})

test('case profile policy cannot be widened or shortened', t => {
  const h = candidateHarness(t)
  const candidate = prepareOperationalPilotCandidate({ context: h.context })
  assert.throws(() => runOperationalPilotValidation({
    context: h.context,
    candidate,
    manifest: boundManifest(h.baselineCommit),
    runtime: inspectingRuntime(),
    profiles: ['diff:check']
  }), /fixed case policy/)
})

test('success evidence crosses review, approval and deterministic export', t => {
  const h = candidateHarness(t)
  const sourceHeadBefore = git(h.source, ['rev-parse', 'HEAD'])
  const sourceStatusBefore = git(h.source, [
    'status',
    '--porcelain',
    '--untracked-files=all'
  ])
  const candidate = prepareOperationalPilotCandidate({ context: h.context })
  const validation = runOperationalPilotValidation({
    context: h.context,
    candidate,
    manifest: boundManifest(h.baselineCommit),
    runtime: inspectingRuntime()
  })
  const result = completeOperationalPilotSuccess({
    context: h.context,
    candidate,
    validation
  })

  assert.equal(result.actualOutcome, 'EXPORTED')
  assert.equal(result.sessionEndState, 'EXPORTED')
  assert.equal(result.reviewCreated, true)
  assert.equal(result.approvalCreated, true)
  assert.equal(result.exportCreated, true)
  assert.match(result.exportSha256, /^[0-9a-f]{64}$/)
  assert.equal(result.patchProof.candidateTree, candidate.treeSha)
  assert.equal(
    result.patchProof.baselineTree,
    result.patchProof.restoredTree
  )
  assert.equal(
    result.patchProof.forwardPatchSha256,
    candidate.forwardPatchSha256
  )
  assert.equal(
    result.patchProof.reversePatchSha256,
    candidate.reversePatchSha256
  )
  assert.equal(h.context.database.prepare(`
    SELECT COUNT(*) AS count FROM editor_review_sets
  `).get().count, 1)
  assert.equal(h.context.database.prepare(`
    SELECT COUNT(*) AS count FROM editor_approval_records
  `).get().count, 1)
  assert.equal(h.context.database.prepare(`
    SELECT COUNT(*) AS count FROM editor_pilot_export_records
  `).get().count, 1)
  assert.equal(git(h.source, ['rev-parse', 'HEAD']), sourceHeadBefore)
  assert.equal(git(h.source, [
    'status',
    '--porcelain',
    '--untracked-files=all'
  ]), sourceStatusBefore)
})

test('validation rejection cannot create review, approval or export', t => {
  const h = candidateHarness(t, { caseName: 'validation-reject' })
  const candidate = prepareOperationalPilotCandidate({ context: h.context })
  const validation = runOperationalPilotValidation({
    context: h.context,
    candidate,
    manifest: boundManifest(h.baselineCommit),
    runtime: inspectingRuntime()
  })
  assert.throws(() => completeOperationalPilotSuccess({
    context: h.context,
    candidate,
    validation
  }), /Only the success case/)
  for (const table of [
    'editor_review_sets',
    'editor_approval_records',
    'editor_pilot_export_records'
  ]) {
    assert.equal(h.context.database.prepare(
      `SELECT COUNT(*) AS count FROM ${table}`
    ).get().count, 0)
  }
})

test('case cleanup is idempotent and removes only its owned directory', t => {
  const h = candidateHarness(t)
  const canary = path.join(h.pilotRoot, 'unrelated-canary.txt')
  fs.writeFileSync(canary, 'safe\n')
  const caseRoot = h.context.caseRoot
  assert.equal(fs.existsSync(caseRoot), true)
  assert.deepEqual(h.context.cleanup(), {
    removed: true,
    alreadyAbsent: false
  })
  assert.equal(fs.existsSync(caseRoot), false)
  assert.equal(fs.readFileSync(canary, 'utf8'), 'safe\n')
  assert.deepEqual(h.context.cleanup(), {
    removed: false,
    alreadyAbsent: true
  })
})

test('candidate context rejects a mismatched baseline', t => {
  const outer = fs.mkdtempSync(
    path.join(os.tmpdir(), 'e3-operational-pilot-mismatch-')
  )
  t.after(() => fs.rmSync(outer, { recursive: true, force: true }))
  const source = createSourceRepository(outer)
  const pilotRoot = path.join(
    outer,
    'echolink-e3-operational-pilot-mismatch'
  )
  fs.mkdirSync(pilotRoot, { mode: 0o700 })
  assert.throws(() => createOperationalPilotCaseContext({
    pilotRoot,
    caseName: 'success',
    baselineCommit: 'f'.repeat(40),
    repositoryRoot: source.source,
    sourceRepositoryPath: source.source
  }), /does not match/)
})

test('controlled adapters still exercise summary boundaries', async () => {
  const files = new Map()
  const result = await runOperationalPilot({
    cases: [...E3_OPERATIONAL_PILOT_CASES],
    pilotRoot: '/tmp/echolink-e3-operational-pilot-summary-test',
    baselineCommit: 'd'.repeat(40),
    manifest,
    adapters: adapter(),
    fsApi: {
      mkdirSync: () => {},
      chmodSync: () => {},
      writeFileSync: (p, b) => {
        if (files.has(p)) throw new Error('duplicate')
        files.set(p, b)
      }
    }
  })
  assert.equal(result.result, 'READY')
  assert.equal(result.cases.length, 3)
  assert.equal(result.cases[0].sessionEndState, 'EXPORTED')
  assert.equal(
    result.cases[0].profiles.length,
    E3_OPERATIONAL_PILOT_PROFILES.length
  )
})

test('partial failure is retained and never ready', async () => {
  const files = new Map()
  const result = await runOperationalPilot({
    cases: ['success'],
    pilotRoot: '/tmp/echolink-e3-operational-pilot-fail-test',
    baselineCommit: 'd'.repeat(40),
    manifest,
    adapters: {
      runCase: async () => ({
        case: 'success',
        actualOutcome: 'EXPORTED',
        sessionEndState: 'EXPORTED',
        profiles: []
      })
    },
    fsApi: {
      mkdirSync: () => {},
      chmodSync: () => {},
      writeFileSync: (p, b) => files.set(p, b)
    }
  })
  assert.equal(result.result, 'FAILED')
  assert.equal(result.cases[0].actualOutcome, 'FAILED')
})


test('real adapter executes the fixed catalog and removes all case roots', async t => {
  const outer = fs.mkdtempSync(
    path.join(os.tmpdir(), 'e3-operational-pilot-adapter-')
  )
  t.after(() => fs.rmSync(outer, { recursive: true, force: true }))
  const source = createSourceRepository(outer)
  const pilotRoot = path.join(
    outer,
    'echolink-e3-operational-pilot-adapter-test'
  )
  const sourceHeadBefore = git(source.source, ['rev-parse', 'HEAD'])
  const sourceStatusBefore = git(source.source, [
    'status',
    '--porcelain',
    '--untracked-files=all'
  ])
  const result = await runOperationalPilot({
    cases: [...E3_OPERATIONAL_PILOT_CASES],
    pilotRoot,
    baselineCommit: source.baselineCommit,
    manifest: boundManifest(source.baselineCommit),
    repositoryRoot: source.source,
    adapters: createOperationalPilotAdapter({
      repositoryRoot: source.source,
      sourceRepositoryPath: source.source,
      runtimeFactory: () => inspectingRuntime()
    })
  })

  assert.equal(result.result, 'READY')
  assert.deepEqual(
    result.cases.map(item => item.actualOutcome),
    ['EXPORTED', 'VALIDATION_REJECTED', 'TAMPER_REJECTED']
  )
  assert.deepEqual(fs.readdirSync(pilotRoot), ['pilot-summary.json'])
  assert.equal(result.cases.every(item =>
    item.cleanup.caseRoot === 'removed' &&
    item.cleanup.database === 'closed'
  ), true)
  assert.equal(
    Object.hasOwn(result.cases[0].profiles[0], 'stdout'),
    false
  )
  assert.equal(
    Object.hasOwn(result.cases[0].profiles[0], 'stderr'),
    false
  )
  assert.equal(git(source.source, ['rev-parse', 'HEAD']), sourceHeadBefore)
  assert.equal(git(source.source, [
    'status',
    '--porcelain',
    '--untracked-files=all'
  ]), sourceStatusBefore)
})

test('single real case helper retains only verified result data', t => {
  const h = candidateHarness(t, { caseName: 'validation-reject' })
  const result = runOperationalPilotCase({
    name: 'validation-reject',
    baselineCommit: h.baselineCommit,
    manifest: boundManifest(h.baselineCommit),
    pilotRoot: h.pilotRoot,
    repositoryRoot: h.source,
    sourceRepositoryPath: h.source,
    runtime: inspectingRuntime()
  })
  assert.equal(result.actualOutcome, 'VALIDATION_REJECTED')
  assert.equal(result.rejectionCode, 'DIFF_CHECK_FAILED')
  assert.deepEqual(result.databaseCounts, {
    validationEvidence: 1,
    reviewSets: 0,
    approvalRecords: 0,
    exportRecords: 0
  })
  assert.equal(result.cleanup.caseRoot, 'removed')
  assert.equal(result.cleanup.database, 'closed')
})

test('operator CLI is explicit, default-off and product-runtime free', () => {
  const source = fs.readFileSync(
    new URL('../scripts/e3-operational-pilot.mjs', import.meta.url),
    'utf8'
  )
  const packageJson = JSON.parse(fs.readFileSync(
    new URL('../package.json', import.meta.url),
    'utf8'
  ))
  for (const required of [
    "const REPOSITORY_ROOT = '/root/echolink'",
    "const GIT = '/usr/bin/git'",
    "const DOCKER = '/usr/bin/docker'",
    'E3_PILOT_HARNESS_ENABLED',
    'createOperationalPilotAdapter',
    'pilot-attestation.json',
    'E3_STEP14A2_OPERATIONAL_PILOT_SUCCESS',
    'E3_STEP14A2_IMPLEMENTATION_READY'
  ]) {
    assert.equal(source.includes(required), true, required)
  }
  for (const forbidden of [
    'server/index.js',
    'server/worker.js',
    'npm run deploy',
    'pm2 restart',
    'systemctl',
    'git push'
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden)
  }
  assert.equal(
    packageJson.scripts['e3:pilot'],
    'node scripts/e3-operational-pilot.mjs'
  )
})

test('success pipeline wires existing gates without product runtime exposure', () => {
  const source = fs.readFileSync(
    new URL('../server/e3/pilot/operationalPilot.js', import.meta.url),
    'utf8'
  )
  for (const required of [
    'ValidationBroker',
    'ValidationSnapshotMaterializer',
    'DockerValidationRuntime',
    'DockerUiValidationRuntime',
    'ValidationProfileRegistry',
    'ValidationEvidenceService',
    'ReviewGate',
    'ApprovalGate',
    'PilotExportService',
    'parseDeterministicTar',
    'E3_REVIEW_ERROR.ARTIFACT_TAMPERED'
  ]) {
    assert.equal(source.includes(required), true, required)
  }
  for (const forbidden of [
    'server/index.js',
    'server/worker.js',
    'pm2',
    'npm run deploy',
    'git push'
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden)
  }
})
