import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  E3_OPERATIONAL_PILOT_INTERRUPTION_CASES,
  E3_OPERATIONAL_PILOT_INTERRUPTION_EXIT_CODE,
  runOperationalPilotInterruptionCase
} from '../server/e3/pilot/interruptionPilot.js'

import {
  E3_OPERATIONAL_PILOT_INTERRUPTION_CASES as POLICY_INTERRUPTION_CASES
} from '../server/e3/pilot/operationalPilot.js'

const GIT = '/usr/bin/git'

function git(cwd, args) {
  return execFileSync(GIT, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: '/usr/bin:/bin',
      HOME: cwd,
      LANG: 'C',
      LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0'
    }
  }).trim()
}

function createSource(root) {
  const source = path.join(root, 'source')
  fs.mkdirSync(source)
  git(source, ['init', '--initial-branch=main'])
  git(source, ['config', 'user.name', 'E3 Interruption Test'])
  git(source, ['config', 'user.email', 'e3-interruption@example.invalid'])
  fs.mkdirSync(path.join(source, 'docs'), { recursive: true })
  fs.mkdirSync(
    path.join(source, 'tests/fixtures/e3-validation-ui'),
    { recursive: true }
  )
  fs.writeFileSync(path.join(source, 'README.md'), '# interruption fixture\n')
  fs.writeFileSync(path.join(source, 'docs/baseline.txt'), 'baseline\n')
  fs.writeFileSync(
    path.join(source, 'tests/fixtures/e3-validation-ui/app.js'),
    "const app = document.querySelector('#app')\n" +
      "app.dataset.e3Validation = 'ready'\n" +
      "app.textContent = 'E3 isolated UI validation is ready.'\n"
  )
  fs.writeFileSync(
    path.join(source, 'tests/fixtures/e3-validation-ui/index.html'),
    '<!doctype html><title>E3 Validation Fixture</title><main id="app"></main>\n'
  )
  fs.writeFileSync(
    path.join(source, 'tests/fixtures/e3-validation-ui/expected.json'),
    '{\n  "marker": "ready",\n  "title": "E3 Validation Fixture"\n}\n'
  )
  git(source, ['add', '--all'])
  git(source, ['commit', '-m', 'interruption baseline'])
  return {
    source,
    baselineCommit: git(source, ['rev-parse', 'HEAD'])
  }
}

function harness(t) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'e3-interruption-pilot-test-')
  )
  const source = createSource(root)
  const pilotRoot = path.join(
    root,
    'echolink-e3-operational-pilot-interruption-test'
  )
  const manifest = Object.freeze({
    sourceHead: source.baselineCommit,
    manifestSha256: 'c'.repeat(64),
    nodeImageDigest: `sha256:${'a'.repeat(64)}`,
    playwrightImageDigest: `sha256:${'b'.repeat(64)}`
  })
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { root, pilotRoot, manifest, ...source }
}

function execute(t, name) {
  const h = harness(t)
  const headBefore = git(h.source, ['rev-parse', 'HEAD'])
  const statusBefore = git(h.source, [
    'status', '--porcelain', '--untracked-files=all'
  ])
  const result = runOperationalPilotInterruptionCase({
    name,
    pilotRoot: h.pilotRoot,
    baselineCommit: h.baselineCommit,
    manifest: h.manifest,
    repositoryRoot: h.source,
    sourceRepositoryPath: h.source
  })
  assert.equal(result.case, name)
  assert.equal(result.actualOutcome, 'PROCESS_ABORT_RECOVERED')
  assert.equal(result.workerBoundary, 'independent-node-process')
  assert.equal(
    result.workerExitCode,
    E3_OPERATIONAL_PILOT_INTERRUPTION_EXIT_CODE
  )
  assert.match(result.workerStdoutSha256, /^[0-9a-f]{64}$/)
  assert.match(result.workerStderrSha256, /^[0-9a-f]{64}$/)
  assert.deepEqual(result.cleanup, {
    caseRoot: 'removed',
    database: 'closed'
  })
  assert.deepEqual(fs.readdirSync(h.pilotRoot), [])
  assert.equal(git(h.source, ['rev-parse', 'HEAD']), headBefore)
  assert.equal(git(h.source, [
    'status', '--porcelain', '--untracked-files=all'
  ]), statusBefore)
  return result
}

test('process abort after mutation preimage recovers exactly once', t => {
  const result = execute(t, 'abort-after-mutation-preimage')
  assert.equal(result.checkpoint, 'MUTATION_PREIMAGE_RETAINED')
  assert.equal(result.recoveryDecision, 'MUTATION_RECORDED')
  assert.equal(result.sessionEndState, 'EDITING')
  assert.equal(result.replayVerified, true)
  assert.deepEqual(result.databaseCounts, {
    operations: 1,
    preimages: 1
  })
})

test('process abort after filesystem publication recovers postimage', t => {
  const result = execute(t, 'abort-after-published-mutation')
  assert.equal(result.checkpoint, 'MUTATION_FILESYSTEM_PUBLISHED')
  assert.equal(result.recoveryDecision, 'MUTATION_RECORDED')
  assert.equal(result.sessionEndState, 'EDITING')
  assert.equal(result.replayVerified, true)
})

test('process abort after candidate freeze preserves bound artifacts', t => {
  const result = execute(t, 'abort-after-candidate-freeze')
  assert.equal(result.checkpoint, 'CANDIDATE_FROZEN')
  assert.equal(result.recoveryDecision, 'CANDIDATE_DURABILITY_VERIFIED')
  assert.equal(result.sessionEndState, 'EDITING')
  assert.equal(result.replayVerified, true)
  assert.match(result.candidateId, /^[0-9a-f-]{36}$/)
  assert.match(result.candidateManifestSha256, /^[0-9a-f]{64}$/)
})

test('process abort after validation snapshot removes it idempotently', t => {
  const result = execute(t, 'abort-after-validation-snapshot')
  assert.equal(result.checkpoint, 'VALIDATION_SNAPSHOT_PUBLISHED')
  assert.equal(result.recoveryDecision, 'SNAPSHOT_REMOVED')
  assert.equal(
    result.recoveryTransition,
    'VALIDATING->RECOVERING->EDITING'
  )
  assert.equal(result.sessionEndState, 'EDITING')
  assert.equal(result.snapshotCleanupVerified, true)
  assert.equal(result.replayVerified, true)
})

test('process abort after export replays and completes recovery', t => {
  const result = execute(t, 'abort-after-export')
  assert.equal(result.checkpoint, 'EXPORT_COMMITTED')
  assert.equal(result.recoveryDecision, 'CLEANED')
  assert.equal(result.recoveryReason, 'EXPORTED_WORKSPACE')
  assert.equal(result.sessionEndState, 'COMPLETED')
  assert.equal(result.replayVerified, true)
  assert.equal(result.workspaceRemoved, true)
  assert.match(result.exportId, /^[0-9a-f-]{36}$/)
  assert.match(result.exportSha256, /^[0-9a-f]{64}$/)
})

test('interruption catalog and worker surface are closed', () => {
  assert.equal(
    E3_OPERATIONAL_PILOT_INTERRUPTION_CASES,
    POLICY_INTERRUPTION_CASES
  )
  assert.deepEqual(E3_OPERATIONAL_PILOT_INTERRUPTION_CASES, [
    'abort-after-mutation-preimage',
    'abort-after-published-mutation',
    'abort-after-candidate-freeze',
    'abort-after-validation-snapshot',
    'abort-after-export'
  ])
  assert.throws(() => runOperationalPilotInterruptionCase({
    name: 'arbitrary-command'
  }), /not registered/)
  const source = fs.readFileSync(
    new URL('../server/e3/pilot/interruptionPilot.js', import.meta.url),
    'utf8'
  )
  for (const forbidden of [
    'npm run deploy',
    'pm2',
    'systemctl',
    'git push',
    'server/index.js',
    'server/worker.js'
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden)
  }
  assert.match(
    source,
    /TMPDIR:\s*process\.env\.TMPDIR === '\/e3\/tmp'/
  )
})
