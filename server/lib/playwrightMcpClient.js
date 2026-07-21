import { connectMcpHttpClient } from './mcpHttpClient.js'

export const PLAYWRIGHT_MCP_SERVER = 'playwright'
export const DEFAULT_PLAYWRIGHT_MCP_URL =
  'http://127.0.0.1:3012/mcp'
export const DEFAULT_PLAYWRIGHT_ALLOWED_ORIGIN =
  'http://127.0.0.1:3000'
export const PLAYWRIGHT_MCP_IMAGE =
  'mcr.microsoft.com/playwright/mcp:v0.0.78'

export const PLAYWRIGHT_MCP_TOOL_SPECS =
  Object.freeze([
    Object.freeze({
      name: 'browser_navigate',
      readOnly: false
    }),
    Object.freeze({
      name: 'browser_snapshot',
      readOnly: true
    }),
    Object.freeze({
      name: 'browser_find',
      readOnly: true
    }),
    Object.freeze({
      name: 'browser_click',
      readOnly: false
    }),
    Object.freeze({
      name: 'browser_type',
      readOnly: false
    }),
    Object.freeze({
      name: 'browser_console_messages',
      readOnly: true
    }),
    Object.freeze({
      name: 'browser_network_requests',
      readOnly: true
    }),
    Object.freeze({
      name: 'browser_tabs',
      readOnly: false
    }),
    Object.freeze({
      name: 'browser_close',
      readOnly: false
    })
  ])

export const PLAYWRIGHT_MCP_OFFICIAL_TOOLS =
  Object.freeze(
    PLAYWRIGHT_MCP_TOOL_SPECS.map(
      tool => tool.name
    )
  )

export function playwrightMcpExecutionMode(
  env = process.env
) {
  const value = String(
    env.MCP_PLAYWRIGHT_MODE || 'disabled'
  ).trim().toLowerCase()

  if (
    value === 'active' ||
    value === 'on' ||
    value === 'enabled' ||
    value === '1' ||
    value === 'true'
  ) {
    return 'active'
  }

  return 'disabled'
}

function exactLocalMcpUrl(value) {
  let url

  try {
    url = new URL(String(value || ''))
  } catch {
    throw new Error(
      'MCP_PLAYWRIGHT_URL ist ungültig'
    )
  }

  const valid =
    url.protocol === 'http:' &&
    url.hostname === '127.0.0.1' &&
    url.port === '3012' &&
    url.pathname === '/mcp' &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash

  if (!valid) {
    throw new Error(
      'MCP_PLAYWRIGHT_URL muss exakt auf http://127.0.0.1:3012/mcp zeigen'
    )
  }

  return DEFAULT_PLAYWRIGHT_MCP_URL
}

function normalizedOrigin(value) {
  let url

  try {
    url = new URL(String(value || ''))
  } catch {
    throw new Error(
      `Ungültige Playwright-Origin: ${value}`
    )
  }

  const valid =
    (url.protocol === 'http:' ||
      url.protocol === 'https:') &&
    !url.username &&
    !url.password &&
    url.pathname === '/' &&
    !url.search &&
    !url.hash &&
    url.hostname.length > 0

  if (!valid || value === '*') {
    throw new Error(
      `Playwright-Origin nicht erlaubt: ${value}`
    )
  }

  return url.origin
}

export function playwrightAllowedOrigins(
  env = process.env
) {
  const raw = String(
    env.MCP_PLAYWRIGHT_ALLOWED_ORIGINS ||
      DEFAULT_PLAYWRIGHT_ALLOWED_ORIGIN
  )

  const values = raw
    .split(';')
    .map(value => value.trim())
    .filter(Boolean)
    .map(normalizedOrigin)

  const origins = [...new Set(values)]

  if (origins.length === 0) {
    throw new Error(
      'Mindestens eine Playwright-Origin ist erforderlich'
    )
  }

  return origins
}

export function playwrightMcpConfigured(
  env = process.env
) {
  try {
    exactLocalMcpUrl(
      env.MCP_PLAYWRIGHT_URL ||
        DEFAULT_PLAYWRIGHT_MCP_URL
    )
    playwrightAllowedOrigins(env)
    return true
  } catch {
    return false
  }
}

export function playwrightMcpEnabled(
  env = process.env
) {
  return (
    playwrightMcpExecutionMode(env) === 'active' &&
    playwrightMcpConfigured(env)
  )
}

export function playwrightMcpConfig(
  env = process.env
) {
  playwrightAllowedOrigins(env)

  return {
    url: exactLocalMcpUrl(
      env.MCP_PLAYWRIGHT_URL ||
        DEFAULT_PLAYWRIGHT_MCP_URL
    ),
    headers: {
      'X-EchoLink-MCP-Client': 'playwright'
    }
  }
}

export async function connectPlaywrightMcpClient({
  url,
  headers,
  name = 'echolink-playwright-mcp-client',
  signal
}) {
  return connectMcpHttpClient({
    url,
    headers,
    name,
    signal
  })
}
