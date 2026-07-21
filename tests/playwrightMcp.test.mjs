import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
  PLAYWRIGHT_MCP_IMAGE,
  PLAYWRIGHT_MCP_OFFICIAL_TOOLS,
  playwrightAllowedOrigins,
  playwrightMcpConfig,
  playwrightMcpExecutionMode
} from '../server/lib/playwrightMcpClient.js'
import {
  executePlaywrightTool,
  PLAYWRIGHT_TOOLS,
  PLAYWRIGHT_TOOL_NAMES,
  sanitizePlaywrightResult,
  sanitizePlaywrightToolArgs
} from '../server/lib/playwrightTools.js'
import {
  getMcpRegistryStatus,
  resetMcpRegistryForTests
} from '../server/lib/mcpRegistry.js'

const ENV = {
  MCP_PLAYWRIGHT_MODE: 'active',
  MCP_PLAYWRIGHT_URL:
    'http://127.0.0.1:3012/mcp',
  MCP_PLAYWRIGHT_ALLOWED_ORIGINS:
    'http://127.0.0.1:3000;https://echo.example',
  MCP_PLAYWRIGHT_REQUEST_TIMEOUT_MS: '2500',
  MCP_PLAYWRIGHT_TOOL_TIMEOUT_MS: '2200',
  MCP_PLAYWRIGHT_FALLBACK_COOLDOWN_MS: '1000',
  MCP_WEB_MODE: 'direct',
  GITHUB_MCP_MODE: 'disabled',
  SESSION_SECRET: 'session-secret-1234567890'
}

function playwrightConnection({
  tools = PLAYWRIGHT_MCP_OFFICIAL_TOOLS,
  onCall
} = {}) {
  return async options => ({
    options,
    client: {
      async listTools() {
        return {
          tools: tools.map(name => ({ name }))
        }
      },
      async callTool(request) {
        onCall?.(request, options)
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(request)
          }]
        }
      }
    },
    async close() {}
  })
}

test.beforeEach(() => {
  resetMcpRegistryForTests()
})

test('Playwright MCP ist opt-in, lokal gepinnt und verlangt exakte Origins', () => {
  assert.equal(
    playwrightMcpExecutionMode({}),
    'disabled'
  )
  assert.equal(
    playwrightMcpExecutionMode({
      MCP_PLAYWRIGHT_MODE: 'active'
    }),
    'active'
  )
  assert.equal(
    PLAYWRIGHT_MCP_IMAGE,
    'mcr.microsoft.com/playwright/mcp:v0.0.78'
  )
  assert.equal(
    playwrightMcpConfig(ENV).url,
    'http://127.0.0.1:3012/mcp'
  )
  assert.deepEqual(
    playwrightAllowedOrigins(ENV),
    [
      'http://127.0.0.1:3000',
      'https://echo.example'
    ]
  )

  assert.throws(
    () => playwrightMcpConfig({
      ...ENV,
      MCP_PLAYWRIGHT_URL:
        'http://0.0.0.0:3012/mcp'
    }),
    /exakt auf/
  )
  assert.throws(
    () => playwrightAllowedOrigins({
      MCP_PLAYWRIGHT_ALLOWED_ORIGINS: '*'
    }),
    /nicht erlaubt|Ungültige/
  )
  assert.throws(
    () => playwrightAllowedOrigins({
      MCP_PLAYWRIGHT_ALLOWED_ORIGINS:
        'file:///root/.env'
    }),
    /nicht erlaubt/
  )
})

test('Registry veröffentlicht nur die neun kuratierten Playwright-Tools', async () => {
  const statuses = await getMcpRegistryStatus({
    env: ENV,
    connectors: {
      playwright: playwrightConnection({
        tools: [
          ...PLAYWRIGHT_MCP_OFFICIAL_TOOLS,
          'browser_run_code_unsafe',
          'browser_evaluate',
          'browser_file_upload',
          'browser_take_screenshot'
        ]
      })
    },
    forceDiscovery: true
  })

  const server = statuses.find(
    item => item.name === 'playwright'
  )

  assert.ok(server)
  assert.equal(server.mode, 'active')
  assert.equal(server.configured, true)
  assert.equal(server.reachable, true)
  assert.equal(server.readOnly, false)
  assert.equal(server.tools.length, 9)
  assert.ok(
    server.tools.some(tool => tool.readOnly)
  )
  assert.ok(
    server.tools.some(tool => !tool.readOnly)
  )
  assert.ok(
    server.tools.every(
      tool => tool.fallbackAllowed === false
    )
  )

  const serialized = JSON.stringify(server)

  for (const blocked of [
    'browser_run_code_unsafe',
    'browser_evaluate',
    'browser_file_upload',
    'browser_take_screenshot'
  ]) {
    assert.doesNotMatch(serialized, new RegExp(blocked))
  }
})

test('Navigation wird vor der MCP-Verbindung auf die Origin-Allowlist begrenzt', async () => {
  let call
  let connections = 0

  await executePlaywrightTool(
    'browser_navigate',
    {
      url: 'http://127.0.0.1:3000/login?next=%2F'
    },
    {
      env: ENV,
      connectFn: async options => {
        connections += 1
        return playwrightConnection({
          onCall(request) {
            call = request
          }
        })(options)
      }
    }
  )

  assert.equal(connections, 1)
  assert.equal(call.name, 'browser_navigate')
  assert.equal(
    call.arguments.url,
    'http://127.0.0.1:3000/login?next=%2F'
  )

  await assert.rejects(
    executePlaywrightTool(
      'browser_navigate',
      { url: 'https://example.org/' },
      {
        env: ENV,
        connectFn: async () => {
          connections += 1
          return playwrightConnection()()
        }
      }
    ),
    error =>
      error?.name ===
        'PlaywrightMcpOriginBlockedError'
  )

  assert.equal(connections, 1)
})

test('Browser-Aktionen entfernen Datei- und Submit-Funktionen und blockieren Gefahren', () => {
  assert.deepEqual(
    sanitizePlaywrightToolArgs(
      'browser_snapshot',
      {
        target: 'e12',
        depth: 99,
        filename: '/root/leak.md',
        boxes: true
      },
      ENV
    ),
    {
      target: 'e12',
      depth: 15
    }
  )

  assert.deepEqual(
    sanitizePlaywrightToolArgs(
      'browser_type',
      {
        element: 'Search field',
        target: 'e7',
        text: 'EchoLink',
        submit: true,
        filename: '/tmp/output'
      },
      ENV
    ),
    {
      element: 'Search field',
      target: 'e7',
      text: 'EchoLink',
      submit: false,
      slowly: false
    }
  )

  assert.throws(
    () => sanitizePlaywrightToolArgs(
      'browser_click',
      {
        element: 'Delete conversation',
        target: 'e8'
      },
      ENV
    ),
    /gefährlicher Browser-Klick/
  )
  assert.throws(
    () => sanitizePlaywrightToolArgs(
      'browser_type',
      {
        element: 'Password',
        target: 'e9',
        text: 'secret'
      },
      ENV
    ),
    /Sensible Browser-Eingabe/
  )
  assert.throws(
    () => sanitizePlaywrightToolArgs(
      'browser_tabs',
      {
        action: 'new',
        url: 'https://example.org/'
      },
      ENV
    ),
    /Tab-Aktion blockiert/
  )
  assert.throws(
    () => sanitizePlaywrightToolArgs(
      'browser_click',
      {
        element: 'Settings',
        target: '#settings'
      },
      ENV
    ),
    /Selektoren sind blockiert/
  )
})

test('Codeausführung bleibt auch bei direktem Wrapper-Aufruf blockiert', async () => {
  let connected = false

  await assert.rejects(
    executePlaywrightTool(
      'browser_run_code_unsafe',
      { code: 'process.exit()' },
      {
        env: ENV,
        connectFn: async () => {
          connected = true
          return playwrightConnection()()
        }
      }
    ),
    error =>
      error?.name === 'PlaywrightMcpToolBlockedError'
  )

  assert.equal(connected, false)
  assert.equal(PLAYWRIGHT_TOOLS.length, 9)
  assert.equal(PLAYWRIGHT_TOOL_NAMES.size, 9)

  for (const blocked of [
    'browser_run_code',
    'browser_run_code_unsafe',
    'browser_evaluate',
    'browser_file_upload',
    'browser_drop',
    'browser_take_screenshot',
    'browser_pdf_save'
  ]) {
    assert.ok(
      !PLAYWRIGHT_MCP_OFFICIAL_TOOLS.includes(blocked)
    )
  }

  assert.equal(
    sanitizePlaywrightResult(
      'Bearer top-secret?token=abc&password=def',
      ENV
    ),
    'Bearer [redacted]'
  )
})

test('Chat, Agent, PM2, Deploy und Container-Härtung sind vollständig verdrahtet', async () => {
  const [
    chat,
    agent,
    registry,
    ecosystem,
    deploy,
    envExample,
    launcher,
    initPage,
    smoke
  ] = await Promise.all([
    readFile(
      new URL('../server/routes/chat.js', import.meta.url),
      'utf8'
    ),
    readFile(
      new URL('../server/lib/agentRunner.js', import.meta.url),
      'utf8'
    ),
    readFile(
      new URL('../server/lib/toolRegistry.js', import.meta.url),
      'utf8'
    ),
    readFile(
      new URL('../ecosystem.config.cjs', import.meta.url),
      'utf8'
    ),
    readFile(
      new URL('../scripts/deploy.sh', import.meta.url),
      'utf8'
    ),
    readFile(
      new URL('../.env.example', import.meta.url),
      'utf8'
    ),
    readFile(
      new URL('../server/mcp/playwrightLauncher.js', import.meta.url),
      'utf8'
    ),
    readFile(
      new URL('../server/mcp/playwrightInitPage.ts', import.meta.url),
      'utf8'
    ),
    readFile(
      new URL('../scripts/mcp-playwright-smoke.js', import.meta.url),
      'utf8'
    )
  ])

  assert.match(chat, /PLAYWRIGHT_TOOL_NAMES\.has\(name\)/)
  assert.match(agent, /playwrightMcpEnabled\(\)/)
  assert.match(agent, /source: 'scheduled-agent'/)
  assert.match(registry, /playwrightMcpEnabled\(\)/)
  assert.match(ecosystem, /echolink-mcp-playwright/)
  assert.match(deploy, /mcp-playwright-smoke\.js/)
  assert.match(deploy, /docker image inspect/)
  assert.match(envExample, /MCP_PLAYWRIGHT_MODE=disabled/)
  assert.match(
    envExample,
    /MCP_PLAYWRIGHT_ALLOWED_ORIGINS=http:\/\/127\.0\.0\.1:3000/
  )

  for (const marker of [
    '--network=host',
    '127.0.0.1:3012,localhost:3012',
    '--read-only',
    '--tmpfs=/home/node:rw,nosuid,nodev,noexec,size=64m,uid=1000,gid=1000,mode=0700',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges:true',
    '--pull=never',
    '--isolated',
    '--shared-browser-context',
    '--block-service-workers',
    '--init-page',
    '/opt/echolink/playwrightInitPage.ts',
    "'none'",
    "'omit'"
  ]) {
    assert.match(
      launcher,
      new RegExp(
        marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      )
    )
  }

  assert.doesNotMatch(
    launcher,
    /allow-unrestricted-file-access|user-data-dir|storage-state|grant-permissions/
  )
  assert.match(initPage, /context\.route\('\*\*\/\*'/)
  assert.match(initPage, /origins\.has\(url\.origin\)/)
  assert.match(initPage, /download\.cancel\(\)/)
  assert.match(initPage, /chooser\.setFiles\(\[\]\)/)
  assert.match(initPage, /routeWebSocket/)
  assert.match(initPage, /context\.addInitScript/)
  assert.match(initPage, /Navigator\.prototype/)
  assert.match(initPage, /document\.addEventListener\('submit'/)
  assert.match(initPage, /anchor\.hasAttribute\('download'\)/)
  assert.match(smoke, /browser_snapshot/)
  assert.doesNotMatch(
    smoke,
    /executePlaywrightTool\(\s*['"]browser_(?:run_code|evaluate|file_upload|take_screenshot)/
  )
})
