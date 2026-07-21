import '../server/loadEnv.js'

import {
  connectMcpWebClient,
  mcpWebConfig
} from '../server/lib/mcpWebClient.js'

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

let connection

try {
  const config = mcpWebConfig()

  connection = await connectMcpWebClient({
    ...config,
    name: 'echolink-mcp-web-smoke'
  })

  const listed = await connection.client.listTools()
  const names = listed.tools.map(tool => tool.name)

  for (const expected of expectedTools) {
    if (!names.includes(expected)) {
      throw new Error(
        `MCP-Tool fehlt: ${expected}`
      )
    }
  }

  console.log(JSON.stringify({
    ok: true,
    event: 'mcp_web_tools_discovered',
    tools: names
  }))

  if (!listOnly) {
    const result = await connection.client.callTool({
      name: 'web_search',
      arguments: { query }
    })

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
      event: 'mcp_web_search_completed',
      query,
      resultLength: text.length
    }))
  }
} finally {
  await connection?.close().catch(() => {})
}
