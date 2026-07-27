import '../server/loadEnv.js'

import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

function flag(name) {
  return process.argv.includes(`--${name}`)
}

export function evaluateRuntimeSmoke(
  result,
  {
    expectedBackend = '',
    allowToolError = false
  } = {}
) {
  const backendMatches =
    !expectedBackend ||
    result.backend === expectedBackend
  const toolErrorTolerated = Boolean(
    allowToolError &&
    expectedBackend &&
    backendMatches &&
    result.fallback === false &&
    result.error
  )

  return {
    accepted:
      backendMatches &&
      (!result.error || toolErrorTolerated),
    backendMatches,
    toolErrorTolerated
  }
}

async function main() {
  const query =
    argument('query') ||
    'Node.js aktuelle Entwicklung'
  const expectedBackend =
    argument('expect-backend')
  const allowToolError =
    flag('allow-tool-error')
  const mode = mcpWebExecutionMode()

  try {
    const result = await executeWebSearch(
      query,
      {
        source: 'runtime-smoke'
      }
    )
    const evaluation = evaluateRuntimeSmoke(
      result,
      {
        expectedBackend,
        allowToolError
      }
    )

    console.log(JSON.stringify({
      ok: !result.error,
      accepted: evaluation.accepted,
      event: 'mcp_web_runtime_completed',
      mode,
      backend: result.backend,
      fallback: result.fallback,
      query,
      resultCount: result.resultCount || 0,
      resultLength: result.text.length
    }))

    if (evaluation.toolErrorTolerated) {
      console.warn(JSON.stringify({
        ok: true,
        event: 'mcp_web_runtime_tool_error_tolerated',
        backend: result.backend,
        query,
        error: String(result.text || '').slice(0, 200)
      }))
    }

    if (!evaluation.backendMatches) {
      console.error(JSON.stringify({
        ok: false,
        event: 'mcp_web_runtime_backend_mismatch',
        expectedBackend,
        actualBackend: result.backend
      }))
    }

    if (!evaluation.accepted) {
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
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    fileURLToPath(import.meta.url)
) {
  await main()
}
