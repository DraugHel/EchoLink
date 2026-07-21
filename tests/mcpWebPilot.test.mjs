import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { createMcpWebApp } from '../server/mcp/webApp.js'
import {
  assertPublicHttpUrl,
  isPrivateNetworkAddress
} from '../server/mcp/publicUrl.js'

async function listen(app) {
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')

  const address = server.address()

  return {
    server,
    baseUrl:
      `http://127.0.0.1:${address.port}`
  }
}

test('MCP-Web-Pilot entdeckt und ruft read-only Tools auf', async () => {
  const token = 'mcp-test-token-1234567890'

  const app = createMcpWebApp({
    token,
    webSearchFn: async query => ({
      query,
      results: [
        {
          title: 'Test result',
          snippet: 'MCP works',
          source: 'https://example.com/'
        }
      ]
    }),
    firecrawlFn: async url => ({
      url,
      content: 'Test page'
    }),
    publicUrlCheck: async url => url
  })

  const { server, baseUrl } = await listen(app)
  const client = new Client({
    name: 'mcp-web-test',
    version: '1.0.0'
  })
  const transport = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp`),
    {
      requestInit: {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    }
  )

  try {
    await client.connect(transport)

    const tools = await client.listTools()
    const names = tools.tools.map(tool => tool.name)

    assert.deepEqual(
      names.sort(),
      ['firecrawl_scrape', 'web_search']
    )

    assert.ok(
      tools.tools.every(tool =>
        tool.annotations?.readOnlyHint === true &&
        tool.annotations?.destructiveHint === false
      )
    )

    const result = await client.callTool({
      name: 'web_search',
      arguments: {
        query: 'EchoLink MCP test'
      }
    })

    assert.equal(result.isError, undefined)
    assert.match(
      result.content[0].text,
      /MCP works/
    )
    assert.deepEqual(
      result.structuredContent,
      {
        query: 'EchoLink MCP test',
        results: [
          {
            title: 'Test result',
            snippet: 'MCP works',
            source: 'https://example.com/'
          }
        ]
      }
    )
  } finally {
    await client.close().catch(() => {})
    await new Promise(resolve =>
      server.close(resolve)
    )
  }
})

test('MCP-Web-Pilot verlangt Authentifizierung', async () => {
  const app = createMcpWebApp({
    token: 'mcp-test-token-1234567890'
  })
  const { server, baseUrl } = await listen(app)

  try {
    const response = await fetch(
      `${baseUrl}/mcp`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {}
        })
      }
    )

    assert.equal(response.status, 401)
  } finally {
    await new Promise(resolve =>
      server.close(resolve)
    )
  }
})

test('öffentliche URL-Prüfung blockiert lokale Netze', async () => {
  assert.equal(
    isPrivateNetworkAddress('127.0.0.1'),
    true
  )
  assert.equal(
    isPrivateNetworkAddress('10.0.0.5'),
    true
  )
  assert.equal(
    isPrivateNetworkAddress('8.8.8.8'),
    false
  )

  await assert.rejects(
    assertPublicHttpUrl(
      'http://example.test/private',
      async () => [
        {
          address: '192.168.1.10',
          family: 4
        }
      ]
    ),
    /privates Netzwerk|Private Zieladresse/i
  )

  assert.equal(
    await assertPublicHttpUrl(
      'https://example.com/article#section',
      async () => [
        {
          address: '93.184.216.34',
          family: 4
        }
      ]
    ),
    'https://example.com/article'
  )
})

test('Chat und Agent nutzen die gemeinsame MCP-Web-Laufzeit', () => {
  const route = fs.readFileSync(
    new URL(
      '../server/routes/chat.js',
      import.meta.url
    ),
    'utf8'
  )
  const agent = fs.readFileSync(
    new URL(
      '../server/lib/agentRunner.js',
      import.meta.url
    ),
    'utf8'
  )

  assert.match(
    route,
    /from '\.\.\/lib\/readOnlyWebRuntime\.js'/
  )
  assert.match(
    agent,
    /from '\.\/readOnlyWebRuntime\.js'/
  )
  assert.match(route, /executeWebSearch\(/)
  assert.match(route, /executeFirecrawlScrape\(/)
  assert.match(agent, /executeWebSearch\(/)
  assert.match(agent, /executeFirecrawlScrape\(/)
  assert.doesNotMatch(route, /await webSearch\(/)
  assert.doesNotMatch(agent, /await webSearch\(/)
})
