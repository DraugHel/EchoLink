import { spawnSync } from 'node:child_process'

const ALLOWED_EXECUTABLES = Object.freeze(new Set([
  '/usr/bin/node'
]))

function assertExecutable(executable) {
  if (!ALLOWED_EXECUTABLES.has(executable)) {
    throw new Error('Validation driver executable is not allowlisted')
  }
}

function assertArguments(args) {
  if (
    !Array.isArray(args) ||
    args.some(value =>
      typeof value !== 'string' ||
      value.includes('\0') ||
      value.length > 4096
    )
  ) {
    throw new Error('Validation driver arguments are invalid')
  }
}

export function runNode(args, {
  cwd,
  env,
  timeout = 0,
  maxBuffer = 10 * 1024 * 1024
} = {}) {
  const executable = '/usr/bin/node'
  assertExecutable(executable)
  assertArguments(args)
  const result = spawnSync(executable, args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeout || undefined,
    maxBuffer
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `Validation subprocess failed with exit code ${result.status}`
    )
  }
  return result
}
