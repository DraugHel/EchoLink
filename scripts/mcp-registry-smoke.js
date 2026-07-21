import '../server/loadEnv.js'

import {
  getMcpRegistryStatus
} from '../server/lib/mcpRegistry.js'

try {
  const servers = await getMcpRegistryStatus({
    forceDiscovery: true
  })
  const server = servers.find(item =>
    item.name === 'mcp-web'
  )

  if (!server) {
    throw new Error('Registry-Eintrag mcp-web fehlt')
  }

  const expected = [
    'web_search',
    'firecrawl_scrape'
  ]
  const discovered = server.tools
    .filter(tool => tool.discovered)
    .map(tool => tool.name)

  for (const tool of expected) {
    if (!discovered.includes(tool)) {
      throw new Error(`Tool nicht entdeckt: ${tool}`)
    }
  }

  if (server.reachable !== true) {
    throw new Error(
      server.lastError || 'mcp-web ist nicht erreichbar'
    )
  }

  console.log(JSON.stringify({
    ok: true,
    event: 'mcp_registry_status',
    servers
  }))
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    event: 'mcp_registry_status_failed',
    error: error?.message || String(error)
  }))
  process.exitCode = 1
}
