import '../server/loadEnv.js'

import {
  discoverMcpServer
} from '../server/lib/mcpRegistry.js'
import {
  PLAYWRIGHT_MCP_OFFICIAL_TOOLS,
  PLAYWRIGHT_MCP_SERVER,
  playwrightAllowedOrigins,
  playwrightMcpExecutionMode
} from '../server/lib/playwrightMcpClient.js'
import {
  executePlaywrightTool
} from '../server/lib/playwrightTools.js'

const mode = playwrightMcpExecutionMode()

if (mode !== 'active') {
  console.log(JSON.stringify({
    ok: true,
    event: 'playwright_mcp_smoke_skipped',
    mode
  }))
  process.exit(0)
}

function wait(milliseconds) {
  return new Promise(resolve => {
    setTimeout(resolve, milliseconds)
  })
}

async function reachableStatus() {
  let status

  for (let attempt = 1; attempt <= 10; attempt++) {
    status = await discoverMcpServer(
      PLAYWRIGHT_MCP_SERVER,
      { force: true }
    )

    if (status.reachable === true) return status
    if (attempt < 10) await wait(1_000)
  }

  return status
}

const status = await reachableStatus()

if (!status?.configured || !status.reachable) {
  throw new Error(
    status?.lastError ||
    'Playwright MCP ist nicht erreichbar'
  )
}

const discovered = status.tools
  .filter(tool => tool.discovered)
  .map(tool => tool.name)

for (const tool of PLAYWRIGHT_MCP_OFFICIAL_TOOLS) {
  if (!discovered.includes(tool)) {
    throw new Error(
      `Playwright-Tool nicht entdeckt: ${tool}`
    )
  }
}

for (const blocked of [
  'browser_run_code',
  'browser_run_code_unsafe',
  'browser_evaluate',
  'browser_file_upload',
  'browser_drop',
  'browser_take_screenshot',
  'browser_pdf_save'
]) {
  if (discovered.includes(blocked)) {
    throw new Error(
      `Gefährliches Playwright-Tool freigegeben: ${blocked}`
    )
  }
}

const [origin] = playwrightAllowedOrigins()
let snapshot = ''

try {
  await executePlaywrightTool(
    'browser_navigate',
    { url: `${origin}/` },
    { source: 'playwright-mcp-smoke' }
  )

  snapshot = await executePlaywrightTool(
    'browser_snapshot',
    { depth: 8 },
    { source: 'playwright-mcp-smoke' }
  )

  if (!snapshot.trim()) {
    throw new Error(
      'Playwright-Snapshot ist leer'
    )
  }

  await executePlaywrightTool(
    'browser_console_messages',
    { level: 'error' },
    { source: 'playwright-mcp-smoke' }
  )

  await executePlaywrightTool(
    'browser_network_requests',
    {},
    { source: 'playwright-mcp-smoke' }
  )
} finally {
  await executePlaywrightTool(
    'browser_close',
    {},
    { source: 'playwright-mcp-smoke' }
  ).catch(() => {})
}

console.log(JSON.stringify({
  ok: true,
  event: 'playwright_mcp_smoke_completed',
  server: status.name,
  mode: status.mode,
  image: 'mcr.microsoft.com/playwright/mcp:v0.0.78',
  allowedOrigin: origin,
  toolCount: discovered.length,
  snapshotCharacters: snapshot.length
}))
