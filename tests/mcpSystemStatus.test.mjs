import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const systemRoute = await readFile(
  new URL('../server/routes/system.js', import.meta.url),
  'utf8'
)
const panel = await readFile(
  new URL(
    '../client/src/components/SystemStatusPanel.jsx',
    import.meta.url
  ),
  'utf8'
)

test('Systemstatus bleibt authentifiziert und ergänzt bekannte MCP-Registry-Daten', () => {
  assert.match(
    systemRoute,
    /'\/status',[\s\S]*requireAuth/
  )
  assert.match(
    systemRoute,
    /getMcpRegistryStatus\(\)/
  )
  assert.match(
    systemRoute,
    /mcpServers/
  )
  assert.doesNotMatch(
    systemRoute,
    /req\.(?:body|query|params).*MCP/i
  )
})

test('SystemStatusPanel zeigt MCP-Server, Tools und read-only Metriken', () => {
  for (const marker of [
    'MCP-Server',
    'server.configured',
    'server.readOnly',
    'server.latencyMs',
    'server.lastSuccessfulConnection',
    'server.errorCount',
    'server.fallbackCount',
    'server.circuitBreaker',
    'tool.timeoutMs',
    'tool.readOnly',
    'tool.fallbackAllowed'
  ]) {
    assert.match(panel, new RegExp(marker.replace('.', '\\.')))
  }

  assert.doesNotMatch(panel, /MCP_WEB_TOKEN/)
  assert.doesNotMatch(panel, /onToggleMcp|setMcp.*enabled/i)
})
