import '../loadEnv.js'

import { createMcpWebApp } from './webApp.js'

const HOST = process.env.MCP_WEB_HOST || '127.0.0.1'
const PORT = Number(process.env.MCP_WEB_PORT || 3011)
const MODE = process.env.MCP_WEB_MODE || 'active'
const TOKEN =
  process.env.MCP_WEB_TOKEN ||
  process.env.SESSION_SECRET

const INVALID_TOKENS = new Set([
  'aender-mich',
  'echolink-change-this-secret',
  'hier-langen-zufallsstring-rein'
])

if (HOST !== '127.0.0.1') {
  console.error(
    'FATAL: echolink-mcp-web darf nur an 127.0.0.1 binden.'
  )
  process.exit(1)
}

if (
  !Number.isInteger(PORT) ||
  PORT < 1 ||
  PORT > 65535
) {
  console.error('FATAL: MCP_WEB_PORT ist ungültig.')
  process.exit(1)
}

if (
  !TOKEN ||
  INVALID_TOKENS.has(TOKEN)
) {
  console.error(
    'FATAL: MCP_WEB_TOKEN oder ein gültiges SESSION_SECRET fehlt.'
  )
  process.exit(1)
}

let app

try {
  app = createMcpWebApp({
    token: TOKEN,
    mode: MODE
  })
} catch (error) {
  console.error(`FATAL: ${error.message}`)
  process.exit(1)
}

const server = app.listen(PORT, HOST, () => {
  console.log(JSON.stringify({
    level: 'info',
    event: 'mcp_web_started',
    host: HOST,
    port: PORT,
    mode: MODE
  }))
})

function shutdown(signal) {
  console.log(JSON.stringify({
    level: 'info',
    event: 'mcp_web_stopping',
    signal
  }))

  server.close(error => {
    if (error) {
      console.error(error)
      process.exit(1)
    }

    process.exit(0)
  })

  setTimeout(() => process.exit(1), 10_000)
    .unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
