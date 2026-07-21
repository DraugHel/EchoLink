import test from 'node:test'
import assert from 'node:assert/strict'

import {
  executeFirecrawlScrape,
  executeWebSearch,
  mcpWebExecutionMode,
  resetMcpWebCircuitForTests
} from '../server/lib/readOnlyWebRuntime.js'

const ACTIVE_ENV = {
  MCP_WEB_MODE: 'active',
  MCP_WEB_TOKEN: 'mcp-test-token-1234567890',
  MCP_WEB_URL: 'http://127.0.0.1:3011/mcp',
  MCP_WEB_REQUEST_TIMEOUT_MS: '2000',
  MCP_WEB_FALLBACK_COOLDOWN_MS: '1000'
}

function connectionWith(result) {
  return async () => ({
    client: {
      async callTool() {
        return result
      }
    },
    async close() {}
  })
}

test.beforeEach(() => {
  resetMcpWebCircuitForTests()
})

test('MCP-Web ist standardmäßig aktiv und direkt abschaltbar', () => {
  assert.equal(mcpWebExecutionMode({}), 'active')
  assert.equal(
    mcpWebExecutionMode({ MCP_WEB_MODE: 'direct' }),
    'direct'
  )
  assert.equal(
    mcpWebExecutionMode({ MCP_WEB_MODE: 'shadow' }),
    'direct'
  )
})

test('Websuche verwendet MCP als primären Backend-Pfad', async () => {
  let directCalls = 0

  const result = await executeWebSearch(
    'EchoLink MCP activation',
    {
      env: ACTIVE_ENV,
      connectFn: connectionWith({
        content: [
          {
            type: 'text',
            text: '[1] MCP result\nWorks\nSource: https://example.com/'
          }
        ],
        structuredContent: {
          query: 'EchoLink MCP activation',
          results: [
            {
              title: 'MCP result',
              snippet: 'Works',
              source: 'https://example.com/'
            }
          ]
        }
      }),
      searchFn: async () => {
        directCalls += 1
        return { error: 'must not run' }
      }
    }
  )

  assert.equal(result.backend, 'mcp')
  assert.equal(result.fallback, false)
  assert.equal(result.error, false)
  assert.equal(result.resultCount, 1)
  assert.deepEqual(
    result.sources,
    ['https://example.com/']
  )
  assert.equal(directCalls, 0)
})

test('MCP-Ausfall fällt kontrolliert auf direkte Websuche zurück', async () => {
  let directCalls = 0

  const result = await executeWebSearch(
    'Fallback test',
    {
      env: ACTIVE_ENV,
      connectFn: async () => {
        throw new Error('MCP unavailable')
      },
      searchFn: async query => {
        directCalls += 1
        return {
          query,
          results: [
            {
              title: 'Direct result',
              snippet: 'Fallback works',
              source: 'https://example.org/'
            }
          ]
        }
      }
    }
  )

  assert.equal(result.backend, 'direct')
  assert.equal(result.fallback, true)
  assert.equal(result.error, false)
  assert.equal(directCalls, 1)
  assert.match(result.text, /Fallback works/)
})

test('Chat-Abbruch startet nach MCP-Abbruch keinen direkten Fallback', async () => {
  const controller = new AbortController()
  let directCalls = 0

  controller.abort()

  await assert.rejects(
    executeWebSearch(
      'Abort test',
      {
        signal: controller.signal,
        env: ACTIVE_ENV,
        connectFn: async ({ signal }) => {
          if (signal.aborted) {
            const error = new Error('aborted')
            error.name = 'AbortError'
            throw error
          }

          throw new Error('unexpected')
        },
        searchFn: async () => {
          directCalls += 1
          return { error: 'must not run' }
        }
      }
    ),
    error => error?.name === 'AbortError'
  )

  assert.equal(directCalls, 0)
})

test('Scrape validiert öffentliche URLs vor MCP und Fallback', async () => {
  let connectCalls = 0
  let directCalls = 0

  const result = await executeFirecrawlScrape(
    'http://127.0.0.1/private',
    {
      env: ACTIVE_ENV,
      publicUrlCheck: async () => {
        throw new Error('Private Zieladressen sind nicht erlaubt')
      },
      connectFn: async () => {
        connectCalls += 1
        throw new Error('must not run')
      },
      scrapeFn: async () => {
        directCalls += 1
        return { error: 'must not run' }
      }
    }
  )

  assert.equal(result.backend, 'validation')
  assert.equal(result.error, true)
  assert.equal(result.fallback, false)
  assert.match(result.text, /Private Zieladressen/)
  assert.equal(connectCalls, 0)
  assert.equal(directCalls, 0)
})
