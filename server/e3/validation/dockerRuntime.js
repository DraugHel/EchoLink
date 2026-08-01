import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  assertCanonicalSessionId
} from '../core/contracts.js'
import {
  E3_VALIDATION_LIMITS,
  E3_VALIDATION_NETWORK_MODE
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
        'Validation output contains a symlink'
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
        'Validation output contains an unsupported entry'
      )
    }
    entries += 1
    if (entries > MAX_OUTPUT_ENTRIES) {
      runtimeError(
        E3_VALIDATION_ERROR.OUTPUT_LIMIT_EXCEEDED,
        'Validation output contains too many entries'
      )
    }
    bytes += stat.size
  }
  visit(root)
  return bytes
}

function containerName(runId) {
  return `e3-validation-${runId}`
}

function buildDockerArguments(plan, snapshotPath, outputPath) {
  const profile = plan.profile
  const limits = profile.limits
  const args = [
    'run',
    '--rm',
    '--pull',
    'never',
    '--init',
    '--log-driver',
    'none',
    '--name',
    containerName(plan.runId),
    '--label',
    `echolink.e3.run=${plan.runId}`,
    '--label',
    `echolink.e3.session=${plan.sessionId}`,
    '--label',
    `echolink.e3.profile=${profile.id}`,
    '--network',
    'none',
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
    `${profile.user.uid}:${profile.user.gid}`,
    '--mount',
    `type=bind,src=${snapshotPath},dst=/e3/input,readonly`,
    '--mount',
    `type=bind,src=${outputPath},dst=/e3/output`,
    '--tmpfs',
    `/e3/tmp:rw,noexec,nosuid,nodev,size=${limits.outputBytes}`,
    '--entrypoint',
    profile.entrypoint[0]
  ]
  for (const [key, value] of Object.entries(plan.environment).sort()) {
    args.push('--env', `${key}=${value}`)
  }
  args.push(profile.imageDigest, ...profile.entrypoint.slice(1))
  return args
}

function removeTree(root) {
  if (!fs.existsSync(root)) return
  fs.rmSync(root, { recursive: true, force: true })
}

export class DockerValidationRuntime {
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
        'Validation runtime requires the pinned Docker executable'
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
    const inspectionError = Buffer.from(
      inspection.stderr ?? Buffer.alloc(0)
    ).toString('utf8')
    if (
      inspection.status === 0 ||
      !/No such (object|container)/i.test(inspectionError)
    ) {
      runtimeError(
        E3_VALIDATION_ERROR.CLEANUP_FAILED,
        'Validation container absence could not be proven',
        {
          containerName: name,
          inspectStatus: inspection.status
        }
      )
    }
  }

  run(plan, snapshot) {
    try {
      assertCanonicalSessionId(plan.sessionId)
      assertCanonicalSessionId(plan.runId)
    } catch (cause) {
      runtimeError(
        E3_VALIDATION_ERROR.RUNTIME_FAILED,
        'Validation run identity is invalid',
        {},
        cause
      )
    }
    if (
      plan.isolation.networkMode !==
        E3_VALIDATION_NETWORK_MODE.NONE ||
      plan.isolation.hostNetwork !== false ||
      plan.isolation.internetEgress !== false
    ) {
      runtimeError(
        E3_VALIDATION_ERROR.UNSUPPORTED_NETWORK,
        'Step 9 accepts only network-disabled profiles'
      )
    }
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
        'Validation output path already exists'
      )
    }
    fs.mkdirSync(outputPath, { recursive: true, mode: 0o700 })
    let canonicalOutput = outputPath
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
      const name = containerName(plan.runId)
      let execution
      try {
        execution = this.#docker(
          buildDockerArguments(plan, snapshotPath, canonicalOutput),
          {
            timeout: plan.profile.limits.timeoutMs,
            maxBuffer: Math.max(
              plan.profile.limits.stdoutBytes,
              plan.profile.limits.stderrBytes
            )
          }
        )
      } finally {
        this.#cleanupContainer(name)
      }
      const bytes = outputUsage(canonicalOutput)
      if (bytes > plan.profile.limits.outputBytes) {
        runtimeError(
          E3_VALIDATION_ERROR.OUTPUT_LIMIT_EXCEEDED,
          'Validation output exceeds the profile limit',
          { bytes }
        )
      }
      if (execution.error) {
        runtimeError(
          E3_VALIDATION_ERROR.RUNTIME_FAILED,
          'Validation container process failed',
          {
            code: execution.error.code ?? null,
            signal: execution.signal ?? null
          },
          execution.error
        )
      }
      const stdout = Buffer.from(execution.stdout ?? Buffer.alloc(0))
      const stderr = Buffer.from(execution.stderr ?? Buffer.alloc(0))
      if (
        stdout.length > plan.profile.limits.stdoutBytes ||
        stderr.length > plan.profile.limits.stderrBytes
      ) {
        runtimeError(
          E3_VALIDATION_ERROR.OUTPUT_LIMIT_EXCEEDED,
          'Validation log exceeds the profile limit'
        )
      }
      const exitCode = execution.status
      return Object.freeze({
        status: plan.profile.allowedExitCodes.includes(exitCode)
          ? 'succeeded'
          : 'failed',
        exitCode,
        signal: execution.signal ?? null,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
        outputBytes: bytes,
        containerName: name
      })
    } finally {
      try {
        removeTree(canonicalOutput)
        const sessionOutput = path.dirname(outputPath)
        if (
          fs.existsSync(sessionOutput) &&
          fs.readdirSync(sessionOutput).length === 0
        ) {
          fs.rmdirSync(sessionOutput)
        }
      } catch (cause) {
        runtimeError(
          E3_VALIDATION_ERROR.CLEANUP_FAILED,
          'Validation output cleanup failed',
          {},
          cause
        )
      }
    }
  }
}

export { buildDockerArguments }
