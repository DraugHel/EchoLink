import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  assertCanonicalSessionId
} from '../core/contracts.js'
import {
  E3_VALIDATION_LIMITS,
  E3_VALIDATION_NETWORK_MODE,
  E3_VALIDATION_PROFILE_ID,
  E3_VALIDATION_UI_NETWORK
} from './contracts.js'
import {
  E3_VALIDATION_ERROR,
  E3ValidationError
} from './errors.js'

const DOCKER = '/usr/bin/docker'
const DOCKER_ENVIRONMENT = Object.freeze({
  PATH: '/usr/bin:/bin',
  HOME: '/nonexistent',
  LANG: 'C',
  LC_ALL: 'C'
})
const FORBIDDEN_ROOTS = new Set(['/', '/root', '/tmp', '/var'])
const MAX_OUTPUT_ENTRIES = 100_000

function runtimeError(code, message, details = {}, cause) {
  throw new E3ValidationError(
    code,
    message,
    details,
    cause ? { cause } : {}
  )
}

function isWithin(root, candidate) {
  return candidate === root ||
    candidate.startsWith(`${root}${path.sep}`)
}

function assertCanonicalRoot(
  rootPath,
  { create = false, fieldName }
) {
  const resolved = path.resolve(rootPath)
  let actual
  let stat
  try {
    if (create) {
      fs.mkdirSync(resolved, { recursive: true, mode: 0o700 })
    }
    actual = fs.realpathSync.native(resolved)
    stat = fs.lstatSync(actual)
  } catch (cause) {
    runtimeError(
      E3_VALIDATION_ERROR.RUNTIME_FAILED,
      `${fieldName} is unavailable`,
      {},
      cause
    )
  }
  if (
    actual !== resolved ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    FORBIDDEN_ROOTS.has(actual) ||
    isWithin('/root/echolink', actual)
  ) {
    runtimeError(
      E3_VALIDATION_ERROR.RUNTIME_FAILED,
      `${fieldName} is not an allowed canonical directory`
    )
  }
  return actual
}

function assertMountPath(root, candidate, fieldName) {
  const resolved = path.resolve(candidate)
  const actual = fs.realpathSync.native(resolved)
  if (
    actual !== resolved ||
    actual === root ||
    !isWithin(root, actual) ||
    actual.includes(',') ||
    actual.includes('\0')
  ) {
    runtimeError(
      E3_VALIDATION_ERROR.RUNTIME_FAILED,
      `${fieldName} is not an allowed canonical path`
    )
  }
  return actual
}

function outputUsage(root) {
  let bytes = 0
  let entries = 0
  const visit = current => {
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink()) {
      runtimeError(
        E3_VALIDATION_ERROR.OUTPUT_LIMIT_EXCEEDED,
        'UI validation output contains a symlink'
      )
    }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(current)) {
        visit(path.join(current, name))
      }
      return
    }
    if (!stat.isFile() || stat.nlink !== 1) {
      runtimeError(
        E3_VALIDATION_ERROR.OUTPUT_LIMIT_EXCEEDED,
        'UI validation output contains an unsupported entry'
      )
    }
    entries += 1
    if (entries > MAX_OUTPUT_ENTRIES) {
      runtimeError(
        E3_VALIDATION_ERROR.OUTPUT_LIMIT_EXCEEDED,
        'UI validation output contains too many entries'
      )
    }
    bytes += stat.size
  }
  visit(root)
  return bytes
}

function names(runId) {
  return Object.freeze({
    network: `e3-vnet-${runId}`,
    application: `e3-vapp-${runId}`,
    browser: `e3-vbrowser-${runId}`
  })
}

function labels(plan, role) {
  return [
    '--label',
    `echolink.e3.run=${plan.runId}`,
    '--label',
    `echolink.e3.session=${plan.sessionId}`,
    '--label',
    `echolink.e3.profile=${plan.profile.id}`,
    '--label',
    `echolink.e3.role=${role}`
  ]
}

function hardenedArguments({
  plan,
  name,
  networkName,
  role,
  definition,
  snapshotPath,
  outputPath,
  detach = false,
  networkAlias
}) {
  const limits = definition.limits
  const args = ['run']
  if (detach) args.push('--detach')
  args.push(
    '--rm',
    '--pull',
    'never',
    '--init',
    '--log-driver',
    'none',
    '--name',
    name,
    ...labels(plan, role),
    '--network',
    networkName
  )
  if (networkAlias) {
    args.push('--network-alias', networkAlias)
  }
  args.push(
    '--ipc',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--security-opt',
    'apparmor=docker-default',
    '--pids-limit',
    String(limits.pids),
    '--memory',
    String(limits.memoryBytes),
    '--cpus',
    (limits.cpuMillis / 1000).toFixed(3),
    '--ulimit',
    `nofile=${limits.openFiles}:${limits.openFiles}`,
    '--user',
    `${definition.user.uid}:${definition.user.gid}`,
    '--mount',
    `type=bind,src=${snapshotPath},dst=/e3/input,readonly`
  )
  if (outputPath) {
    args.push(
      '--mount',
      `type=bind,src=${outputPath},dst=/e3/output`
    )
  }
  args.push(
    '--tmpfs',
    `/e3/tmp:rw,noexec,nosuid,nodev,size=${limits.outputBytes}`,
    '--entrypoint',
    definition.entrypoint[0]
  )
  for (const [key, value] of Object.entries(plan.environment).sort()) {
    args.push('--env', `${key}=${value}`)
  }
  args.push(
    definition.imageDigest,
    ...definition.entrypoint.slice(1)
  )
  return args
}

function buildNetworkCreateArguments(plan) {
  return [
    'network',
    'create',
    '--internal',
    '--driver',
    'bridge',
    '--label',
    `echolink.e3.run=${plan.runId}`,
    '--label',
    `echolink.e3.session=${plan.sessionId}`,
    names(plan.runId).network
  ]
}

function buildApplicationArguments(
  plan,
  snapshotPath
) {
  const pair = plan.profile.internalPair
  const owned = names(plan.runId)
  return hardenedArguments({
    plan,
    name: owned.application,
    networkName: owned.network,
    role: 'application',
    definition: pair.application,
    snapshotPath,
    detach: true,
    networkAlias: pair.applicationAlias
  })
}

function buildBrowserArguments(
  plan,
  snapshotPath,
  outputPath
) {
  const owned = names(plan.runId)
  return hardenedArguments({
    plan,
    name: owned.browser,
    networkName: owned.network,
    role: 'browser',
    definition: plan.profile,
    snapshotPath,
    outputPath
  })
}

function removeTree(root) {
  if (!fs.existsSync(root)) return
  fs.rmSync(root, { recursive: true, force: true })
}

function assertPairPlan(plan) {
  const pair = plan.profile.internalPair
  if (
    plan.profile.id !== E3_VALIDATION_PROFILE_ID.PLAYWRIGHT_UI ||
    plan.profile.role !== 'browser' ||
    plan.isolation.networkMode !==
      E3_VALIDATION_NETWORK_MODE.INTERNAL_PAIR ||
    plan.isolation.hostNetwork !== false ||
    plan.isolation.internetEgress !== false ||
    pair?.applicationAlias !==
      E3_VALIDATION_UI_NETWORK.applicationAlias ||
    pair?.applicationPort !==
      E3_VALIDATION_UI_NETWORK.applicationPort ||
    pair?.testOrigin !== E3_VALIDATION_UI_NETWORK.testOrigin ||
    plan.environment.E3_TEST_ORIGIN !==
      E3_VALIDATION_UI_NETWORK.testOrigin ||
    pair?.application?.role !== 'application' ||
    plan.profile.user?.uid === 0 ||
    plan.profile.user?.gid === 0 ||
    pair?.application?.user?.uid === 0 ||
    pair?.application?.user?.gid === 0
  ) {
    runtimeError(
      E3_VALIDATION_ERROR.UNSUPPORTED_NETWORK,
      'UI validation plan is not the fixed internal pair'
    )
  }
}

function executionError(execution, role) {
  if (execution.error) {
    runtimeError(
      E3_VALIDATION_ERROR.RUNTIME_FAILED,
      `${role} container process failed`,
      {
        code: execution.error.code ?? null,
        signal: execution.signal ?? null
      },
      execution.error
    )
  }
}

export class DockerUiValidationRuntime {
  constructor({
    outputRoot,
    snapshotRoot,
    dockerPath = DOCKER,
    spawnSyncImpl = spawnSync,
    chownSyncImpl = fs.chownSync
  }) {
    if (dockerPath !== DOCKER) {
      runtimeError(
        E3_VALIDATION_ERROR.RUNTIME_FAILED,
        'UI validation requires the pinned Docker executable'
      )
    }
    this.outputRoot = assertCanonicalRoot(outputRoot, {
      create: true,
      fieldName: 'outputRoot'
    })
    this.snapshotRoot = assertCanonicalRoot(snapshotRoot, {
      fieldName: 'snapshotRoot'
    })
    this.spawnSync = spawnSyncImpl
    this.chownSync = chownSyncImpl
  }

  #docker(args, options = {}) {
    return this.spawnSync(DOCKER, args, {
      encoding: null,
      env: DOCKER_ENVIRONMENT,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: options.maxBuffer ??
        E3_VALIDATION_LIMITS.maxStdoutBytes,
      timeout: options.timeout
    })
  }

  #cleanupContainer(name) {
    this.#docker(['rm', '--force', name], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024
    })
    const inspection = this.#docker(['inspect', name], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024
    })
    const message = Buffer.from(
      inspection.stderr ?? Buffer.alloc(0)
    ).toString('utf8')
    if (
      inspection.status === 0 ||
      !/No such (object|container)/i.test(message)
    ) {
      runtimeError(
        E3_VALIDATION_ERROR.CLEANUP_FAILED,
        'UI validation container absence could not be proven',
        { containerName: name, inspectStatus: inspection.status }
      )
    }
  }

  #cleanupNetwork(name) {
    this.#docker(['network', 'rm', name], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024
    })
    const inspection = this.#docker(
      ['network', 'inspect', name],
      {
        timeout: 10_000,
        maxBuffer: 1024 * 1024
      }
    )
    const message = Buffer.from(
      inspection.stderr ?? Buffer.alloc(0)
    ).toString('utf8')
    if (
      inspection.status === 0 ||
      !/(?:No such network|network .+ not found)/i.test(message)
    ) {
      runtimeError(
        E3_VALIDATION_ERROR.CLEANUP_FAILED,
        'UI validation network absence could not be proven',
        { networkName: name, inspectStatus: inspection.status }
      )
    }
  }

  #applicationRunning(name) {
    const inspection = this.#docker([
      'inspect',
      '--format',
      '{{.State.Running}}',
      name
    ], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024
    })
    return inspection.status === 0 &&
      Buffer.from(inspection.stdout ?? Buffer.alloc(0))
        .toString('utf8')
        .trim() === 'true'
  }

  run(plan, snapshot) {
    try {
      assertCanonicalSessionId(plan.sessionId)
      assertCanonicalSessionId(plan.runId)
    } catch (cause) {
      runtimeError(
        E3_VALIDATION_ERROR.RUNTIME_FAILED,
        'UI validation run identity is invalid',
        {},
        cause
      )
    }
    assertPairPlan(plan)
    const snapshotPath = assertMountPath(
      this.snapshotRoot,
      snapshot.path,
      'snapshotPath'
    )
    const outputPath = path.join(
      this.outputRoot,
      plan.sessionId,
      plan.runId
    )
    if (fs.existsSync(outputPath)) {
      runtimeError(
        E3_VALIDATION_ERROR.RUNTIME_FAILED,
        'UI validation output path already exists'
      )
    }
    fs.mkdirSync(outputPath, { recursive: true, mode: 0o700 })
    let canonicalOutput = outputPath
    let result
    let operationError
    let cleanupError
    const owned = names(plan.runId)
    try {
      this.chownSync(
        outputPath,
        plan.profile.user.uid,
        plan.profile.user.gid
      )
      canonicalOutput = assertMountPath(
        this.outputRoot,
        outputPath,
        'outputPath'
      )
      const network = this.#docker(
        buildNetworkCreateArguments(plan),
        { timeout: 30_000, maxBuffer: 1024 * 1024 }
      )
      executionError(network, 'UI network creation')
      if (network.status !== 0) {
        runtimeError(
          E3_VALIDATION_ERROR.RUNTIME_FAILED,
          'Internal UI validation network could not be created',
          { exitCode: network.status }
        )
      }
      const application = this.#docker(
        buildApplicationArguments(plan, snapshotPath),
        { timeout: 30_000, maxBuffer: 1024 * 1024 }
      )
      executionError(application, 'UI application')
      if (application.status !== 0) {
        runtimeError(
          E3_VALIDATION_ERROR.RUNTIME_FAILED,
          'UI application container could not be started',
          { exitCode: application.status }
        )
      }
      const browser = this.#docker(
        buildBrowserArguments(
          plan,
          snapshotPath,
          canonicalOutput
        ),
        {
          timeout: plan.profile.limits.timeoutMs,
          maxBuffer: Math.max(
            plan.profile.limits.stdoutBytes,
            plan.profile.limits.stderrBytes
          )
        }
      )
      executionError(browser, 'UI browser')
      if (!this.#applicationRunning(owned.application)) {
        runtimeError(
          E3_VALIDATION_ERROR.RUNTIME_FAILED,
          'UI application did not remain alive for the browser run'
        )
      }
      const stdout = Buffer.from(browser.stdout ?? Buffer.alloc(0))
      const stderr = Buffer.from(browser.stderr ?? Buffer.alloc(0))
      if (
        stdout.length > plan.profile.limits.stdoutBytes ||
        stderr.length > plan.profile.limits.stderrBytes
      ) {
        runtimeError(
          E3_VALIDATION_ERROR.OUTPUT_LIMIT_EXCEEDED,
          'UI validation log exceeds the profile limit'
        )
      }
      const bytes = outputUsage(canonicalOutput)
      if (bytes > plan.profile.limits.outputBytes) {
        runtimeError(
          E3_VALIDATION_ERROR.OUTPUT_LIMIT_EXCEEDED,
          'UI validation output exceeds the profile limit',
          { bytes }
        )
      }
      result = Object.freeze({
        status: plan.profile.allowedExitCodes.includes(browser.status)
          ? 'succeeded'
          : 'failed',
        exitCode: browser.status,
        signal: browser.signal ?? null,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
        outputBytes: bytes,
        networkName: owned.network,
        applicationContainerName: owned.application,
        browserContainerName: owned.browser
      })
    } catch (error) {
      operationError = error
    }

    for (const name of [owned.browser, owned.application]) {
      try {
        this.#cleanupContainer(name)
      } catch (error) {
        cleanupError ??= error
      }
    }
    try {
      this.#cleanupNetwork(owned.network)
    } catch (error) {
      cleanupError ??= error
    }
    try {
      removeTree(canonicalOutput)
      const sessionOutput = path.dirname(outputPath)
      if (
        fs.existsSync(sessionOutput) &&
        fs.readdirSync(sessionOutput).length === 0
      ) {
        fs.rmdirSync(sessionOutput)
      }
    } catch (error) {
      cleanupError ??= error
    }

    if (cleanupError) {
      runtimeError(
        E3_VALIDATION_ERROR.CLEANUP_FAILED,
        'UI validation cleanup failed',
        {},
        cleanupError
      )
    }
    if (operationError) {
      if (operationError instanceof E3ValidationError) {
        throw operationError
      }
      runtimeError(
        E3_VALIDATION_ERROR.RUNTIME_FAILED,
        'UI validation runtime failed',
        {},
        operationError
      )
    }
    return result
  }
}

export {
  buildApplicationArguments,
  buildBrowserArguments,
  buildNetworkCreateArguments
}
