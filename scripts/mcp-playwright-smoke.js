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
  createPlaywrightToolSession
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
const expectedUrl = new URL('/', origin).toString()
const session = createPlaywrightToolSession({
  source: 'playwright-mcp-smoke'
})
let snapshot = ''
let consoleMessages = ''
let networkRequests = ''

try {
  await session.execute(
    'browser_navigate',
    { url: expectedUrl }
  )

  snapshot = await session.execute(
    'browser_snapshot',
    { depth: 8 }
  )

  if (
    !snapshot.trim() ||
    /about:blank/i.test(snapshot)
  ) {
    throw new Error(
      'Playwright-Snapshot ist leer oder about:blank'
    )
  }

  if (!snapshot.includes(`Page URL: ${expectedUrl}`)) {
    throw new Error(
      `Playwright-Snapshot enthält nicht die erwartete URL: ${expectedUrl}`
    )
  }

  if (!/Page Title:\s*EchoLink\b/i.test(snapshot)) {
    throw new Error(
      'Playwright-Snapshot enthält nicht den Seitentitel EchoLink'
    )
  }

  consoleMessages = await session.execute(
    'browser_console_messages',
    { level: 'error' }
  )

  networkRequests = await session.execute(
    'browser_network_requests',
    {}
  )
} finally {
  await session.close()
}

console.log(JSON.stringify({
  ok: true,
  event: 'playwright_mcp_smoke_completed',
  server: status.name,
  mode: status.mode,
  image: 'mcr.microsoft.com/playwright/mcp:v0.0.78',
  allowedOrigin: origin,
  toolCount: discovered.length,
  snapshotCharacters: snapshot.length,
  consoleCharacters: consoleMessages.length,
  networkCharacters: networkRequests.length
}))
