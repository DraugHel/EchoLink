import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  CandidateBuilder
} from '../server/e3/artifacts/candidateBuilder.js'
import {
  E3_VALIDATION_PROFILE_ID,
  E3_VALIDATION_RUNTIME
} from '../server/e3/validation/contracts.js'
import {
  DockerValidationRuntime
} from '../server/e3/validation/dockerRuntime.js'
import {
  E3_VALIDATION_ERROR,
  E3ValidationError
} from '../server/e3/validation/errors.js'
import {
  ValidationProfileRegistry
} from '../server/e3/validation/profileRegistry.js'
import {
  ValidationSnapshotMaterializer,
  validationSnapshotHandle
} from '../server/e3/validation/snapshotMaterializer.js'
import {
  ValidationBroker
} from '../server/e3/validation/validationBroker.js'
import {
  compileValidationPlan
} from '../server/e3/validation/validationPlanner.js'

const GIT = '/usr/bin/git'
const RUN_ID = '223e4567-e89b-42d3-a456-426614174000'
const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000'
const CANDIDATE_SET_ID =
  '323e4567-e89b-42d3-a456-426614174000'
const NODE_DIGEST = `sha256:${'a'.repeat(64)}`
const PLAYWRIGHT_DIGEST = `sha256:${'b'.repeat(64)}`

function git(cwd, args, encoding = 'utf8') {
  return execFileSync(GIT, args, {
    cwd,
    encoding,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: '/usr/bin:/bin',
      HOME: cwd,
      LANG: 'C',
      LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null'
    }
  })
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function profileRegistry() {
  return new ValidationProfileRegistry({
    nodeImageDigest: NODE_DIGEST,
    playwrightImageDigest: PLAYWRIGHT_DIGEST
  })
}

function request(registry, overrides = {}) {
  return {
    version: 1,
    runId: RUN_ID,
    sessionId: SESSION_ID,
    candidateSetId: CANDIDATE_SET_ID,
    candidateManifestSha256: 'c'.repeat(64),
    snapshotHandle: validationSnapshotHandle(SESSION_ID, RUN_ID),
    profileId: E3_VALIDATION_PROFILE_ID.TEST_FULL,
    profileVersion: 1,
    profileSetSha256: registry.sha256,
    requestedAt: 4_000,
    leaseOwner: 'validation-broker-1',
    fencingToken: 7,
    ...overrides
  }
}

function plan(registry, overrides = {}) {
  return compileValidationPlan(request(registry, overrides), {
    registry,
    actualRuntimeVersion: E3_VALIDATION_RUNTIME.version
  })
}

function validationCode(code) {
  return error =>
    error instanceof E3ValidationError &&
    error.code === code
}

function candidateFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e3-vsnapshot-'))
  const source = path.join(root, 'source')
  const mirror = path.join(root, 'mirror.git')
  const snapshotRoot = path.join(root, 'snapshots')
  fs.mkdirSync(source)
  git(source, ['init', '--initial-branch=main'])
  git(source, ['config', 'user.name', 'E3 Test'])
  git(source, ['config', 'user.email', 'e3@example.invalid'])
  fs.mkdirSync(path.join(source, 'src'))
  fs.writeFileSync(path.join(source, 'src', 'a.txt'), 'alpha\n')
  fs.writeFileSync(path.join(source, 'README.md'), '# baseline\n')
  git(source, ['add', '--all'])
  git(source, ['commit', '-m', 'baseline'])
  const baseCommit = git(source, ['rev-parse', 'HEAD']).trim()
  git(root, ['clone', '--bare', source, mirror])
  fs.writeFileSync(path.join(source, 'src', 'a.txt'), 'omega\n')
  fs.writeFileSync(path.join(source, 'src', 'new.js'), 'export const n = 1\n')
  const candidate = new CandidateBuilder().build({
    sessionId: SESSION_ID,
    baseCommit,
    workspacePath: source,
    sessionVersion: 3,
    operations: [
      {
        sequence: 1,
        type: 'replace_exact',
        pathBefore: 'src/a.txt',
        pathAfter: 'src/a.txt',
        preimageSha256: sha256(Buffer.from('alpha\n')),
        postimageSha256: sha256(Buffer.from('omega\n'))
      }
    ],
    generatedAt: 3_000
  })
  const manifestSha256 = sha256(candidate.manifest)
  const materializer = new ValidationSnapshotMaterializer({
    snapshotRoot,
    mirrorPath: mirror
  })
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })
  return {
    root,
    candidate,
    baseCommit,
    manifestSha256,
    materializer,
    snapshotRoot
  }
}

function materializeInput(fixture, overrides = {}) {
  return {
    runId: RUN_ID,
    sessionId: SESSION_ID,
    baseCommit: fixture.baseCommit,
    candidateManifestSha256: fixture.manifestSha256,
    manifestBytes: fixture.candidate.manifest,
    forwardPatch: fixture.candidate.forwardPatch,
    ...overrides
  }
}

test('candidate is materialized without Git metadata and sealed read-only', t => {
  const fixture = candidateFixture(t)
  const originalRenameSync = fs.renameSync
  let sourceModeAtPublication = null
  fs.renameSync = (source, destination) => {
    if (
      path.basename(source) === 'tree' &&
      destination.endsWith(`/${RUN_ID}`)
    ) {
      sourceModeAtPublication = fs.statSync(source).mode & 0o777
    }
    return originalRenameSync(source, destination)
  }
  let snapshot
  try {
    snapshot = fixture.materializer.materialize(
      materializeInput(fixture)
    )
  } finally {
    fs.renameSync = originalRenameSync
  }
  assert.notEqual(sourceModeAtPublication, null)
  assert.notEqual(sourceModeAtPublication & 0o200, 0)
  assert.equal(
    snapshot.handle,
    validationSnapshotHandle(SESSION_ID, RUN_ID)
  )
  assert.equal(
    fs.readFileSync(path.join(snapshot.path, 'src', 'a.txt'), 'utf8'),
    'omega\n'
  )
  assert.equal(
    fs.readFileSync(path.join(snapshot.path, 'src', 'new.js'), 'utf8'),
    'export const n = 1\n'
  )
  assert.equal(fs.existsSync(path.join(snapshot.path, '.git')), false)
  assert.equal(fs.statSync(snapshot.path).mode & 0o222, 0)
  assert.equal(
    fs.statSync(path.join(snapshot.path, 'src', 'a.txt')).mode & 0o222,
    0
  )
  assert.equal(
    fixture.materializer.verify(
      snapshot,
      fixture.candidate.manifest
    ),
    true
  )
  assert.equal(fixture.materializer.remove(snapshot), true)
  assert.equal(fs.existsSync(snapshot.path), false)
})

test('manifest, patch and post-materialization tampering fail closed', t => {
  const fixture = candidateFixture(t)
  assert.throws(
    () => fixture.materializer.materialize(
      materializeInput(fixture, {
        candidateManifestSha256: 'd'.repeat(64)
      })
    ),
    validationCode(E3_VALIDATION_ERROR.INVALID_CANDIDATE)
  )
  assert.throws(
    () => fixture.materializer.materialize(
      materializeInput(fixture, {
        forwardPatch: Buffer.from('not a patch')
      })
    ),
    validationCode(E3_VALIDATION_ERROR.INVALID_SNAPSHOT)
  )
  const snapshot = fixture.materializer.materialize(
    materializeInput(fixture, {
      runId: '423e4567-e89b-42d3-a456-426614174000'
    })
  )
  const changed = path.join(snapshot.path, 'src', 'a.txt')
  fs.chmodSync(snapshot.path, 0o755)
  fs.chmodSync(path.dirname(changed), 0o755)
  fs.chmodSync(changed, 0o644)
  fs.writeFileSync(changed, 'tampered\n')
  assert.throws(
    () => fixture.materializer.verify(
      snapshot,
      fixture.candidate.manifest
    ),
    validationCode(E3_VALIDATION_ERROR.SNAPSHOT_TAMPERED)
  )
  fixture.materializer.remove(snapshot)
  assert.throws(
    () => fixture.materializer.verify(
      snapshot,
      fixture.candidate.manifest
    ),
    validationCode(E3_VALIDATION_ERROR.INVALID_SNAPSHOT)
  )
})

function fakeDocker({ inspectStatus = 1, runResult } = {}) {
  const calls = []
  const execute = (executable, args, options) => {
    calls.push({ executable, args, options })
    if (args[0] === 'inspect') {
      return {
        status: inspectStatus,
        stdout: Buffer.alloc(0),
        stderr: inspectStatus === 0
          ? Buffer.alloc(0)
          : Buffer.from(`Error: No such object: ${args[1]}`)
      }
    }
    if (args[0] === 'rm') {
      return {
        status: 0,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0)
      }
    }
    return runResult ?? {
      status: 0,
      signal: null,
      stdout: Buffer.from('validation ok\n'),
      stderr: Buffer.alloc(0)
    }
  }
  return { calls, execute }
}

function runtimeFixture(t, fakeOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e3-vruntime-'))
  const snapshotRoot = path.join(root, 'snapshots')
  const outputRoot = path.join(root, 'outputs')
  const snapshotPath = path.join(snapshotRoot, SESSION_ID, RUN_ID)
  fs.mkdirSync(snapshotPath, { recursive: true })
  fs.writeFileSync(path.join(snapshotPath, 'fixture.txt'), 'fixture\n')
  const fake = fakeDocker(fakeOptions)
  const runtime = new DockerValidationRuntime({
    outputRoot,
    snapshotRoot,
    spawnSyncImpl: fake.execute,
    chownSyncImpl: () => {}
  })
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return {
    root,
    outputRoot,
    snapshot: {
      path: fs.realpathSync.native(snapshotPath)
    },
    fake,
    runtime
  }
}

test('Docker runtime emits only the fixed hardened argument vector', t => {
  const registry = profileRegistry()
  const fixture = runtimeFixture(t)
  process.env.OPENAI_API_KEY = 'sentinel-secret'
  try {
    const result = fixture.runtime.run(plan(registry), fixture.snapshot)
    assert.equal(result.status, 'succeeded')
    assert.equal(result.stdout, 'validation ok\n')
  } finally {
    delete process.env.OPENAI_API_KEY
  }
  const runCall = fixture.fake.calls.find(call => call.args[0] === 'run')
  assert.equal(runCall.executable, '/usr/bin/docker')
  assert.ok(runCall.args.includes('--read-only'))
  assert.ok(runCall.args.includes('--pull'))
  assert.ok(runCall.args.includes('never'))
  assert.ok(runCall.args.includes('--init'))
  assert.ok(runCall.args.includes('--log-driver'))
  assert.ok(runCall.args.includes('none'))
  assert.ok(runCall.args.includes('--ipc'))
  assert.ok(runCall.args.includes('--cap-drop'))
  assert.ok(runCall.args.includes('ALL'))
  assert.ok(runCall.args.includes('--network'))
  assert.ok(runCall.args.includes('none'))
  assert.ok(runCall.args.includes('no-new-privileges:true'))
  assert.ok(runCall.args.includes(NODE_DIGEST))
  assert.equal(runCall.args.includes('--privileged'), false)
  assert.equal(runCall.args.includes('/var/run/docker.sock'), false)
  assert.equal(runCall.args.join('\n').includes('/root/echolink'), false)
  assert.equal(runCall.args.join('\n').includes('sentinel-secret'), false)
  assert.deepEqual(runCall.options.env, {
    PATH: '/usr/bin:/bin',
    HOME: '/nonexistent',
    LANG: 'C',
    LC_ALL: 'C'
  })
  assert.deepEqual(
    fixture.fake.calls.slice(-2).map(call => call.args[0]),
    ['rm', 'inspect']
  )
  assert.equal(fs.existsSync(path.join(fixture.outputRoot, SESSION_ID)), false)
})

test('timeout and surviving container fail after forced cleanup', t => {
  const registry = profileRegistry()
  const timeout = runtimeFixture(t, {
    runResult: {
      status: null,
      signal: 'SIGTERM',
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      error: Object.assign(new Error('timed out'), {
        code: 'ETIMEDOUT'
      })
    }
  })
  assert.throws(
    () => timeout.runtime.run(plan(registry), timeout.snapshot),
    validationCode(E3_VALIDATION_ERROR.RUNTIME_FAILED)
  )
  assert.deepEqual(
    timeout.fake.calls.slice(-2).map(call => call.args[0]),
    ['rm', 'inspect']
  )

  const survivor = runtimeFixture(t, { inspectStatus: 0 })
  assert.throws(
    () => survivor.runtime.run(plan(registry), survivor.snapshot),
    validationCode(E3_VALIDATION_ERROR.CLEANUP_FAILED)
  )
  assert.equal(
    fs.existsSync(path.join(survivor.outputRoot, SESSION_ID)),
    false
  )
})

test('ambiguous Docker inspect failure never proves cleanup', t => {
  const registry = profileRegistry()
  const fixture = runtimeFixture(t)
  const calls = []
  const runtime = new DockerValidationRuntime({
    outputRoot: path.join(fixture.root, 'ambiguous-output'),
    snapshotRoot: path.dirname(path.dirname(fixture.snapshot.path)),
    chownSyncImpl: () => {},
    spawnSyncImpl(executable, args, options) {
      calls.push({ executable, args, options })
      if (args[0] === 'inspect') {
        return {
          status: 1,
          stdout: Buffer.alloc(0),
          stderr: Buffer.from('Cannot connect to the Docker daemon')
        }
      }
      return {
        status: 0,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0)
      }
    }
  })
  assert.throws(
    () => runtime.run(plan(registry), fixture.snapshot),
    validationCode(E3_VALIDATION_ERROR.CLEANUP_FAILED)
  )
  assert.deepEqual(
    calls.slice(-2).map(call => call.args[0]),
    ['rm', 'inspect']
  )
})

test('Step 9 runtime rejects the networked UI profile', t => {
  const registry = profileRegistry()
  const fixture = runtimeFixture(t)
  const networked = plan(registry, {
    profileId: E3_VALIDATION_PROFILE_ID.PLAYWRIGHT_UI
  })
  assert.throws(
    () => fixture.runtime.run(networked, fixture.snapshot),
    validationCode(E3_VALIDATION_ERROR.UNSUPPORTED_NETWORK)
  )
  assert.throws(
    () => fixture.runtime.run(
      {
        ...plan(registry),
        runId: '../../outside'
      },
      fixture.snapshot
    ),
    validationCode(E3_VALIDATION_ERROR.RUNTIME_FAILED)
  )
  assert.equal(fixture.fake.calls.length, 0)
})

function brokerHarness({
  enabled = true,
  tamperAfterRuntime = false,
  cleanupFails = false,
  candidateOverrides = {}
} = {}) {
  const registry = profileRegistry()
  const state = {
    materialized: 0,
    verified: 0,
    removed: 0,
    tampered: false
  }
  const manifestBytes = Buffer.from('candidate manifest')
  const candidate = {
    id: CANDIDATE_SET_ID,
    sessionId: SESSION_ID,
    baseCommit: 'a'.repeat(40),
    candidateManifestSha256: sha256(manifestBytes),
    manifestBytes,
    forwardPatch: Buffer.from('patch'),
    ...candidateOverrides
  }
  const rawRequest = request(registry, {
    candidateManifestSha256:
      candidate.candidateManifestSha256
  })
  const snapshot = {
    handle: rawRequest.snapshotHandle,
    path: '/isolated/snapshot',
    sessionId: SESSION_ID,
    runId: RUN_ID
  }
  const broker = new ValidationBroker({
    registry,
    actualRuntimeVersion: E3_VALIDATION_RUNTIME.version,
    env: enabled ? { E3_VALIDATION_BROKER_ENABLED: 'true' } : {},
    candidateResolver: () => candidate,
    snapshotMaterializer: {
      materialize() {
        state.materialized += 1
        return snapshot
      },
      verify() {
        state.verified += 1
        if (state.tampered) {
          throw new E3ValidationError(
            E3_VALIDATION_ERROR.SNAPSHOT_TAMPERED,
            'tampered'
          )
        }
        return true
      },
      remove() {
        state.removed += 1
        if (cleanupFails) throw new Error('cleanup failed')
      }
    },
    runtime: {
      run() {
        if (tamperAfterRuntime) state.tampered = true
        return {
          status: 'succeeded',
          exitCode: 0,
          signal: null,
          stdout: 'ok\n',
          stderr: '',
          outputBytes: 0
        }
      }
    }
  })
  return { broker, rawRequest, state }
}

test('broker is default-off and binds both verification passes', () => {
  const disabled = brokerHarness({ enabled: false })
  assert.throws(
    () => disabled.broker.run(disabled.rawRequest),
    validationCode(E3_VALIDATION_ERROR.FEATURE_DISABLED)
  )
  assert.equal(disabled.state.materialized, 0)

  const enabled = brokerHarness()
  const result = enabled.broker.run(enabled.rawRequest)
  assert.equal(result.status, 'succeeded')
  assert.equal(result.profileId, E3_VALIDATION_PROFILE_ID.TEST_FULL)
  assert.equal(enabled.state.materialized, 1)
  assert.equal(enabled.state.verified, 2)
  assert.equal(enabled.state.removed, 1)
  assert.ok(Object.isFrozen(result))
})

test('broker rejects stale identity, tampering and cleanup failure', () => {
  const stale = brokerHarness({
    candidateOverrides: {
      id: '423e4567-e89b-42d3-a456-426614174000'
    }
  })
  assert.throws(
    () => stale.broker.run(stale.rawRequest),
    validationCode(E3_VALIDATION_ERROR.INVALID_CANDIDATE)
  )
  assert.equal(stale.state.materialized, 0)

  const tampered = brokerHarness({ tamperAfterRuntime: true })
  assert.throws(
    () => tampered.broker.run(tampered.rawRequest),
    validationCode(E3_VALIDATION_ERROR.SNAPSHOT_TAMPERED)
  )
  assert.equal(tampered.state.removed, 1)

  const cleanup = brokerHarness({ cleanupFails: true })
  assert.throws(
    () => cleanup.broker.run(cleanup.rawRequest),
    validationCode(E3_VALIDATION_ERROR.CLEANUP_FAILED)
  )
  assert.equal(cleanup.state.removed, 1)
})
