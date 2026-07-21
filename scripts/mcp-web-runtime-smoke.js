import '../server/loadEnv.js'

import {
  executeWebSearch,
  mcpWebExecutionMode
} from '../server/lib/readOnlyWebRuntime.js'

function argument(name) {
  const prefix = `--${name}=`
  const item = process.argv.find(value =>
    value.startsWith(prefix)
  )

  return item
    ? item.slice(prefix.length)
    : ''
}

const query =
  argument('query') ||
  'EchoLink MCP runtime smoke test'
const expectedBackend =
  argument('expect-backend')
const mode = mcpWebExecutionMode()

try {
  const result = await executeWebSearch(
    query,
    {
      source: 'runtime-smoke'
    }
  )

  console.log(JSON.stringify({
    ok: !result.error,
    event: 'mcp_web_runtime_completed',
    mode,
    backend: result.backend,
    fallback: result.fallback,
    query,
    resultCount: result.resultCount || 0,
    resultLength: result.text.length
  }))

  if (result.error) {
    process.exitCode = 1
  }

  if (
    expectedBackend &&
    result.backend !== expectedBackend
  ) {
    console.error(JSON.stringify({
      ok: false,
      event: 'mcp_web_runtime_backend_mismatch',
      expectedBackend,
      actualBackend: result.backend
    }))
    process.exitCode = 1
  }
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    event: 'mcp_web_runtime_failed',
    error: error?.message || String(error)
  }))
  process.exitCode = 1
}
