import '../loadEnv.js'

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  PLAYWRIGHT_MCP_IMAGE,
  playwrightAllowedOrigins
} from '../lib/playwrightMcpClient.js'

const HOST =
  process.env.MCP_PLAYWRIGHT_HOST ||
  '127.0.0.1'
const PORT = Number(
  process.env.MCP_PLAYWRIGHT_PORT || 3012
)
const SERVICE_LABEL =
  'com.echolink.service=playwright-mcp'
const CONTAINER_NAME =
  'echolink-mcp-playwright-runtime'

const moduleDirectory = path.dirname(
  fileURLToPath(import.meta.url)
)
const initPagePath = path.join(
  moduleDirectory,
  'playwrightInitPage.ts'
)

if (HOST !== '127.0.0.1') {
  console.error(
    'FATAL: Playwright MCP darf nur an 127.0.0.1 binden.'
  )
  process.exit(1)
}

if (PORT !== 3012) {
  console.error(
    'FATAL: MCP_PLAYWRIGHT_PORT muss 3012 sein.'
  )
  process.exit(1)
}

if (!existsSync(initPagePath)) {
  console.error(
    'FATAL: Playwright-Origin-Guard fehlt.'
  )
  process.exit(1)
}

let origins

try {
  origins = playwrightAllowedOrigins()
} catch (error) {
  console.error(`FATAL: ${error.message}`)
  process.exit(1)
}

function dockerCommand(args, options = {}) {
  return spawnSync(
    'docker',
    args,
    {
      encoding: 'utf8',
      stdio: options.inherit
        ? 'inherit'
        : ['ignore', 'pipe', 'pipe']
    }
  )
}

function existingRuntimeIds() {
  const result = dockerCommand([
    'ps',
    '-aq',
    '--filter',
    `label=${SERVICE_LABEL}`
  ])

  if (result.error || result.status !== 0) {
    return []
  }

  return String(result.stdout || '')
    .split(/\r?\n/)
    .map(value => value.trim())
    .filter(value => /^[a-f0-9]{12,64}$/i.test(value))
}

function removeOldRuntimes() {
  const ids = existingRuntimeIds()

  if (ids.length === 0) return

  const result = dockerCommand(
    ['rm', '-f', ...ids],
    { inherit: true }
  )

  if (result.error || result.status !== 0) {
    throw new Error(
      'Alter EchoLink-Playwright-Container konnte nicht entfernt werden'
    )
  }
}

const dockerVersion = dockerCommand([
  'version',
  '--format',
  '{{.Server.Version}}'
])

if (
  dockerVersion.error ||
  dockerVersion.status !== 0
) {
  console.error(
    'FATAL: Docker ist für Playwright MCP nicht verfügbar.'
  )
  process.exit(1)
}

try {
  removeOldRuntimes()
} catch (error) {
  console.error(`FATAL: ${error.message}`)
  process.exit(1)
}

const dockerArgs = [
  'run',
  '--rm',
  '--init',
  '--pull=never',
  `--name=${CONTAINER_NAME}`,
  `--label=${SERVICE_LABEL}`,
  '--network=host',
  '--read-only',
  '--cap-drop=ALL',
  '--security-opt=no-new-privileges:true',
  '--pids-limit=256',
  '--memory=1g',
  '--cpus=1.5',
  '--ulimit=nofile=1024:1024',
  '--shm-size=256m',
  '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=128m',
  '--tmpfs=/home/node:rw,nosuid,nodev,noexec,size=64m,uid=1000,gid=1000,mode=0700',
  '--mount',
  `type=bind,src=${initPagePath},dst=/opt/echolink/playwrightInitPage.ts,readonly`,
  '--env',
  `MCP_PLAYWRIGHT_ALLOWED_ORIGINS=${origins.join(';')}`,
  '--entrypoint=node',
  PLAYWRIGHT_MCP_IMAGE,
  '/app/cli.js',
  '--headless',
  '--browser',
  'chromium',
  '--no-sandbox',
  '--host',
  HOST,
  '--port',
  String(PORT),
  '--allowed-hosts',
  '127.0.0.1:3012,localhost:3012',
  '--allowed-origins',
  origins.join(';'),
  '--isolated',
  '--block-service-workers',
  '--init-page',
  '/opt/echolink/playwrightInitPage.ts',
  '--codegen',
  'none',
  '--image-responses',
  'omit',
  '--output-dir',
  '/tmp/playwright-output',
  '--output-mode',
  'stdout',
  '--output-max-size',
  '10485760',
  '--snapshot-mode',
  'full',
  '--console-level',
  'warning',
  '--timeout-action',
  '5000',
  '--timeout-navigation',
  '15000',
  '--viewport-size',
  '1280x720'
]

console.log(JSON.stringify({
  level: 'info',
  event: 'playwright_mcp_launching',
  image: PLAYWRIGHT_MCP_IMAGE,
  host: HOST,
  port: PORT,
  allowedOrigins: origins
}))

const child = spawn(
  'docker',
  dockerArgs,
  {
    stdio: 'inherit',
    env: process.env
  }
)

let stopping = false

function shutdown(signal) {
  if (stopping) return
  stopping = true

  console.log(JSON.stringify({
    level: 'info',
    event: 'playwright_mcp_stopping',
    signal
  }))

  child.kill(signal)

  setTimeout(() => {
    try {
      removeOldRuntimes()
    } catch {}
  }, 8_000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

child.on('error', error => {
  console.error(JSON.stringify({
    level: 'error',
    event: 'playwright_mcp_launch_failed',
    error: error.message
  }))
  process.exit(1)
})

child.on('exit', (code, signal) => {
  console.log(JSON.stringify({
    level: code === 0 ? 'info' : 'error',
    event: 'playwright_mcp_exited',
    code,
    signal
  }))

  process.exit(code ?? (signal ? 1 : 0))
})
