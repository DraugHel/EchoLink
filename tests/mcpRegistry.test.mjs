import test from 'node:test'
import assert from 'node:assert/strict'

import {
  executeMcpRegistryTool,
  getMcpRegistrySnapshot,
  getMcpRegistryStatus,
  recordMcpFallback,
  resetMcpRegistryForTests
} from '../server/lib/mcpRegistry.js'

const ENV = {
  MCP_WEB_MODE: 'active',
  MCP_WEB_TOKEN: 'registry-test-token-123456789',
  SESSION_SECRET: 'session-test-secret-123456789',
  MCP_WEB_URL:
    'http://user:password@127.0.0.1:3011/mcp?token=url-secret#fragment',
  MCP_WEB_REQUEST_TIMEOUT_MS: '2000',
  MCP_WEB_SEARCH_TIMEOUT_MS: '1500',
  MCP_WEB_SCRAPE_TIMEOUT_MS: '1800',
  MCP_WEB_FALLBACK_COOLDOWN_MS: '1000'
}

function connection({
  tools = ['web_search', 'firecrawl_scrape'],
  result = { content: [{ type: 'text', text: 'ok' }] }
} = {}) {
  return async () => ({
    client: {
      async listTools() {
        return {
          tools: tools.map(name => ({ name }))
        }
      },
      async callTool() {
        return result
      }
    },
    async close() {}
  })
}

test.beforeEach(() => {
  resetMcpRegistryForTests()
})

test('Registry zeigt nur bekannte Server und redigiert URL sowie Token', async () => {
  const statuses = await getMcpRegistryStatus({
    env: ENV,
    connectFn: connection({
      tools: [
        'web_search',
        'firecrawl_scrape',
        'dangerous_write_tool'
      ]
    }),
    forceDiscovery: true
  })

  assert.equal(statuses.length, 2)
  const server = statuses.find(item => item.name === 'mcp-web')
  const github = statuses.find(item => item.name === 'github')
  assert.ok(server)
  assert.ok(github)
  assert.equal(github.mode, 'disabled')
  assert.equal(github.configured, false)
  assert.equal(github.reachable, null)
  assert.equal(server.name, 'mcp-web')
  assert.equal(server.url, 'http://127.0.0.1:3011/mcp')
  assert.equal(server.mode, 'active')
  assert.equal(server.reachable, true)
  assert.deepEqual(
    server.tools.map(tool => tool.name),
    ['web_search', 'firecrawl_scrape']
  )
  assert.equal(server.tools[0].timeoutMs, 1500)
  assert.equal(server.tools[1].timeoutMs, 1800)
  assert.ok(server.tools.every(tool => tool.readOnly))
  assert.ok(server.tools.every(tool => tool.fallbackAllowed))
  assert.ok(server.tools.every(tool => tool.discovered))

  const serialized = JSON.stringify(statuses)
  assert.doesNotMatch(serialized, /registry-test-token/)
  assert.doesNotMatch(serialized, /session-test-secret/)
  assert.doesNotMatch(serialized, /url-secret/)
  assert.doesNotMatch(serialized, /password/)
  assert.doesNotMatch(serialized, /dangerous_write_tool/)
})

test('Registry blockiert unbekannte Tools vor jeder Verbindung', async () => {
  let connections = 0

  await assert.rejects(
    executeMcpRegistryTool(
      'mcp-web',
      'unknown_write_tool',
      {},
      {
        env: ENV,
        connectFn: async () => {
          connections += 1
          throw new Error('must not connect')
        }
      }
    ),
    error => error?.name === 'McpRegistryToolBlockedError'
  )

  assert.equal(connections, 0)
})

test('Registry zählt Erfolg, Fehler, Fallback und öffnet den Circuit Breaker', async () => {
  await executeMcpRegistryTool(
    'mcp-web',
    'web_search',
    { query: 'ok' },
    {
      env: ENV,
      connectFn: connection(),
      source: 'registry-test'
    }
  )

  await assert.rejects(
    executeMcpRegistryTool(
      'mcp-web',
      'firecrawl_scrape',
      { url: 'https://example.com/' },
      {
        env: ENV,
        connectFn: async () => {
          throw new Error(
            `failed with ${ENV.MCP_WEB_TOKEN}`
          )
        },
        source: 'registry-test'
      }
    )
  )

  recordMcpFallback(
    'mcp-web',
    'firecrawl_scrape',
    {
      env: ENV,
      source: 'registry-test',
      reason: 'mcp_unavailable',
      error: `Bearer ${ENV.MCP_WEB_TOKEN}`
    }
  )

  const server = getMcpRegistrySnapshot({ env: ENV })
    .find(item => item.name === 'mcp-web')
  assert.equal(server.successCount, 1)
  assert.equal(server.errorCount, 1)
  assert.equal(server.fallbackCount, 1)
  assert.equal(server.circuitBreaker.state, 'open')
  assert.equal(server.reachable, false)
  assert.doesNotMatch(
    server.lastError,
    /registry-test-token/
  )
})
