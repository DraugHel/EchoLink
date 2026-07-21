import '../server/loadEnv.js'

import {
  executeMcpRegistryTool,
  getMcpRegistryStatus
} from '../server/lib/mcpRegistry.js'

const listOnly = process.argv.includes('--list-only')
const queryArgument = process.argv.find(argument =>
  argument.startsWith('--query=')
)
const query = queryArgument
  ? queryArgument.slice('--query='.length)
  : 'Node.js aktuelle Entwicklung'

const expectedTools = new Set([
  'web_search',
  'firecrawl_scrape'
])

try {
  const statuses = await getMcpRegistryStatus({
    forceDiscovery: true
  })
  const server = statuses.find(item =>
    item.name === 'mcp-web'
  )

  if (!server) {
    throw new Error('Registry-Eintrag mcp-web fehlt')
  }

  const names = server.tools
    .filter(tool => tool.discovered)
    .map(tool => tool.name)

  for (const expected of expectedTools) {
    if (!names.includes(expected)) {
      throw new Error(
        `MCP-Tool fehlt: ${expected}`
      )
    }
  }

  console.log(JSON.stringify({
    ok: server.reachable === true,
    event: 'mcp_registry_tools_discovered',
    server: server.name,
    mode: server.mode,
    latencyMs: server.latencyMs,
    tools: names
  }))

  if (!listOnly) {
    const result = await executeMcpRegistryTool(
      'mcp-web',
      'web_search',
      { query },
      { source: 'mcp-web-smoke' }
    )
    const text = (result.content || [])
      .filter(item => item.type === 'text')
      .map(item => item.text)
      .join('\n')

    if (result.isError || !text.trim()) {
      throw new Error(
        text || 'MCP-Websuche lieferte kein Ergebnis'
      )
    }

    console.log(JSON.stringify({
      ok: true,
      event: 'mcp_registry_search_completed',
      server: 'mcp-web',
      tool: 'web_search',
      query,
      resultLength: text.length
    }))
  }
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    event: 'mcp_registry_smoke_failed',
    error: error?.message || String(error)
  }))
  process.exitCode = 1
}
