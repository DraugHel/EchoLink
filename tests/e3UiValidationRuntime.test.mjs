import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  E3_VALIDATION_PROFILE_ID,
  E3_VALIDATION_RUNTIME,
  E3_VALIDATION_UI_NETWORK
} from '../server/e3/validation/contracts.js'
import {
  DockerUiValidationRuntime
} from '../server/e3/validation/dockerUiRuntime.js'
import {
  E3_VALIDATION_ERROR,
  E3ValidationError
} from '../server/e3/validation/errors.js'
import {
  ValidationProfileRegistry
} from '../server/e3/validation/profileRegistry.js'
import {
  compileValidationPlan
} from '../server/e3/validation/validationPlanner.js'

const RUN_ID = '223e4567-e89b-42d3-a456-426614174000'
const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000'
const CANDIDATE_SET_ID =
  '323e4567-e89b-42d3-a456-426614174000'
const NODE_DIGEST = `sha256:${'a'.repeat(64)}`
const PLAYWRIGHT_DIGEST = `sha256:${'b'.repeat(64)}`

function registry() {
  return new ValidationProfileRegistry({
    nodeImageDigest: NODE_DIGEST,
    playwrightImageDigest: PLAYWRIGHT_DIGEST
  })
}

function uiPlan(overrides = {}) {
  const profileRegistry = registry()
  return compileValidationPlan({
    version: 1,
    runId: RUN_ID,
    sessionId: SESSION_ID,
    candidateSetId: CANDIDATE_SET_ID,
    candidateManifestSha256: 'c'.repeat(64),
    snapshotHandle: `validation:${SESSION_ID}:${RUN_ID}`,
    profileId: E3_VALIDATION_PROFILE_ID.PLAYWRIGHT_UI,
    profileVersion: 1,
    profileSetSha256: profileRegistry.sha256,
    requestedAt: 4_000,
    leaseOwner: 'validation-broker-1',
    fencingToken: 7,
    ...overrides
  }, {
    registry: profileRegistry,
    actualRuntimeVersion: E3_VALIDATION_RUNTIME.version
  })
}

function validationCode(code) {
  return error =>
    error instanceof E3ValidationError &&
    error.code === code
}

function option(args, name) {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

function fakeDocker({
  browserResult,
  applicationRunning = true,
  ambiguousNetworkCleanup = false,
  networkMissingMessage = name => `No such network: ${name}`,
  onBrowserRun
} = {}) {
  const calls = []
  const containers = new Set()
  let networkExists = false
  const execute = (executable, args, options) => {
    calls.push({ executable, args: [...args], options })
    if (args[0] === 'network' && args[1] === 'create') {
      networkExists = true
      return {
        status: 0,
        signal: null,
        stdout: Buffer.from(`${args.at(-1)}\n`),
        stderr: Buffer.alloc(0)
      }
    }
    if (args[0] === 'network' && args[1] === 'rm') {
      if (!ambiguousNetworkCleanup) networkExists = false
      return {
        status: ambiguousNetworkCleanup ? 1 : 0,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0)
      }
    }
    if (args[0] === 'network' && args[1] === 'inspect') {
      return networkExists
        ? {
            status: 0,
            signal: null,
            stdout: Buffer.from('{}'),
            stderr: Buffer.alloc(0)
          }
        : {
            status: 1,
            signal: null,
            stdout: Buffer.alloc(0),
            stderr: Buffer.from(networkMissingMessage(args[2]))
          }
    }
    if (args[0] === 'rm') {
      containers.delete(args.at(-1))
      return {
        status: 0,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0)
      }
    }
    if (args[0] === 'inspect') {
      const name = args.at(-1)
      if (args.includes('--format') && containers.has(name)) {
        return {
          status: applicationRunning ? 0 : 1,
          signal: null,
          stdout: applicationRunning
            ? Buffer.from('true\n')
            : Buffer.alloc(0),
          stderr: applicationRunning
            ? Buffer.alloc(0)
            : Buffer.from(`No such object: ${name}`)
        }
      }
      return containers.has(name)
        ? {
            status: 0,
            signal: null,
            stdout: Buffer.from('{}'),
            stderr: Buffer.alloc(0)
          }
        : {
            status: 1,
            signal: null,
            stdout: Buffer.alloc(0),
            stderr: Buffer.from(`No such object: ${name}`)
          }
    }
    if (args[0] === 'run') {
      const name = option(args, '--name')
      if (args.includes('--detach')) {
        containers.add(name)
        return {
          status: 0,
          signal: null,
          stdout: Buffer.from('application-container-id\n'),
          stderr: Buffer.alloc(0)
        }
      }
      onBrowserRun?.(args)
      return browserResult ?? {
        status: 0,
        signal: null,
        stdout: Buffer.from('ui validation ok\n'),
        stderr: Buffer.alloc(0)
      }
    }
    throw new Error(`Unexpected Docker command: ${args.join(' ')}`)
  }
  return {
    calls,
    execute,
    get networkExists() {
      return networkExists
    },
    containers
  }
}

function fixture(t, fakeOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e3-ui-runtime-'))
  const snapshotRoot = path.join(root, 'snapshots')
  const snapshotPath = path.join(
    snapshotRoot,
    SESSION_ID,
    RUN_ID
  )
  const outputRoot = path.join(root, 'outputs')
  fs.mkdirSync(snapshotPath, { recursive: true })
  fs.writeFileSync(path.join(snapshotPath, 'app.js'), 'safe\n')
  const fake = fakeDocker(fakeOptions)
  const runtime = new DockerUiValidationRuntime({
    outputRoot,
    snapshotRoot,
    spawnSyncImpl: fake.execute,
    chownSyncImpl: () => {}
  })
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })
  return {
    root,
    snapshotRoot,
    snapshot: { path: snapshotPath },
    outputRoot,
    fake,
    runtime
  }
}

test('UI runtime creates one internal bridge and two hardened peers', t => {
  const pair = fixture(t)
  const plan = uiPlan()
  const result = pair.runtime.run(plan, pair.snapshot)
  assert.equal(result.status, 'succeeded')
  assert.equal(result.stdout, 'ui validation ok\n')

  const create = pair.fake.calls.find(
    call => call.args[0] === 'network' &&
      call.args[1] === 'create'
  )
  assert.ok(create)
  assert.ok(create.args.includes('--internal'))
  assert.equal(option(create.args, '--driver'), 'bridge')

  const runs = pair.fake.calls.filter(
    call => call.args[0] === 'run'
  )
  assert.equal(runs.length, 2)
  const application = runs.find(call => call.args.includes('--detach'))
  const browser = runs.find(call => !call.args.includes('--detach'))
  assert.ok(application)
  assert.ok(browser)
  assert.equal(
    option(application.args, '--network-alias'),
    E3_VALIDATION_UI_NETWORK.applicationAlias
  )
  assert.ok(application.args.includes(NODE_DIGEST))
  assert.ok(browser.args.includes(PLAYWRIGHT_DIGEST))
  assert.ok(
    browser.args.includes(
      `E3_TEST_ORIGIN=${E3_VALIDATION_UI_NETWORK.testOrigin}`
    )
  )
  for (const call of runs) {
    const serialized = call.args.join('\n')
    assert.ok(call.args.includes('--read-only'))
    assert.ok(call.args.includes('ALL'))
    assert.ok(call.args.includes('no-new-privileges:true'))
    assert.ok(call.args.includes('apparmor=docker-default'))
    assert.equal(call.args.includes('--privileged'), false)
    assert.equal(call.args.includes('--publish'), false)
    assert.equal(serialized.includes('/var/run/docker.sock'), false)
    assert.equal(serialized.includes('/root/echolink'), false)
    assert.equal(serialized.includes('host.docker.internal'), false)
    assert.equal(serialized.includes('sentinel-secret'), false)
  }
  assert.deepEqual(create.options.env, {
    PATH: '/usr/bin:/bin',
    HOME: '/nonexistent',
    LANG: 'C',
    LC_ALL: 'C'
  })
  assert.equal(pair.fake.networkExists, false)
  assert.equal(pair.fake.containers.size, 0)
  assert.equal(
    fs.existsSync(path.join(pair.outputRoot, SESSION_ID)),
    false
  )
})

test('only the browser receives the bounded output mount', t => {
  const pair = fixture(t)
  pair.runtime.run(uiPlan(), pair.snapshot)
  const runs = pair.fake.calls.filter(call => call.args[0] === 'run')
  const application = runs.find(call => call.args.includes('--detach'))
  const browser = runs.find(call => !call.args.includes('--detach'))
  assert.equal(
    application.args.some(value => value.includes('dst=/e3/output')),
    false
  )
  assert.equal(
    browser.args.some(value => value.includes('dst=/e3/output')),
    true
  )
  assert.equal(
    runs.every(call =>
      call.args.some(value =>
        value.includes('dst=/e3/input,readonly')
      )
    ),
    true
  )
})

test('browser failure remains a failed result after proven cleanup', t => {
  const pair = fixture(t, {
    browserResult: {
      status: 7,
      signal: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from('browser failed\n')
    }
  })
  const result = pair.runtime.run(uiPlan(), pair.snapshot)
  assert.equal(result.status, 'failed')
  assert.equal(result.exitCode, 7)
  assert.equal(result.stderr, 'browser failed\n')
  assert.equal(pair.fake.networkExists, false)
  assert.equal(pair.fake.containers.size, 0)
})

test('browser timeout still removes both containers and network', t => {
  const pair = fixture(t, {
    browserResult: {
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
    () => pair.runtime.run(uiPlan(), pair.snapshot),
    validationCode(E3_VALIDATION_ERROR.RUNTIME_FAILED)
  )
  assert.equal(pair.fake.networkExists, false)
  assert.equal(pair.fake.containers.size, 0)
})

test('application must remain alive through the browser run', t => {
  const pair = fixture(t, { applicationRunning: false })
  assert.throws(
    () => pair.runtime.run(uiPlan(), pair.snapshot),
    validationCode(E3_VALIDATION_ERROR.RUNTIME_FAILED)
  )
  assert.equal(pair.fake.networkExists, false)
  assert.equal(pair.fake.containers.size, 0)
})

test(
  'Docker daemon network-not-found wording proves cleanup',
  t => {
    const pair = fixture(t, {
      networkMissingMessage: name =>
        `Error response from daemon: network ${name} not found`
    })

    const result = pair.runtime.run(
      uiPlan(),
      pair.snapshot
    )

    assert.equal(result.status, 'succeeded')
    assert.equal(pair.fake.networkExists, false)
    assert.equal(pair.fake.containers.size, 0)
  }
)

test('ambiguous network cleanup always fails closed', t => {
  const pair = fixture(t, { ambiguousNetworkCleanup: true })
  assert.throws(
    () => pair.runtime.run(uiPlan(), pair.snapshot),
    validationCode(E3_VALIDATION_ERROR.CLEANUP_FAILED)
  )
})

test('caller-mutated pair identity is rejected before Docker', t => {
  const pair = fixture(t)
  const plan = uiPlan()
  assert.throws(
    () => pair.runtime.run({
      ...plan,
      environment: {
        ...plan.environment,
        E3_TEST_ORIGIN: 'http://127.0.0.1:3000'
      }
    }, pair.snapshot),
    validationCode(E3_VALIDATION_ERROR.UNSUPPORTED_NETWORK)
  )
  assert.equal(pair.fake.calls.length, 0)
})

test('a non-UI profile cannot enter the paired runtime', t => {
  const pair = fixture(t)
  const plan = uiPlan()
  assert.throws(
    () => pair.runtime.run({
      ...plan,
      profile: {
        ...plan.profile,
        id: E3_VALIDATION_PROFILE_ID.TEST_FULL
      }
    }, pair.snapshot),
    validationCode(E3_VALIDATION_ERROR.UNSUPPORTED_NETWORK)
  )
  assert.equal(pair.fake.calls.length, 0)
})

test('output traversal through symlinks is rejected and cleaned', t => {
  let outputPath
  const pair = fixture(t, {
    onBrowserRun(args) {
      const mount = args.find(
        value => value.includes('dst=/e3/output')
      )
      outputPath = mount
        .split(',')
        .find(value => value.startsWith('src='))
        .slice(4)
      fs.symlinkSync('/etc/passwd', path.join(outputPath, 'escape'))
    }
  })
  assert.throws(
    () => pair.runtime.run(uiPlan(), pair.snapshot),
    validationCode(E3_VALIDATION_ERROR.OUTPUT_LIMIT_EXCEEDED)
  )
  assert.equal(fs.existsSync(outputPath), false)
})
