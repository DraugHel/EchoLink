import {
  firecrawlScrape,
  webSearch
} from './webSearch.js'
import {
  connectMcpWebClient,
  mcpWebConfig
} from './mcpWebClient.js'
import { assertPublicHttpUrl } from '../mcp/publicUrl.js'

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000
const DEFAULT_FALLBACK_COOLDOWN_MS = 15_000

let mcpUnavailableUntil = 0

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10)

  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : fallback
}

export function mcpWebExecutionMode(
  env = process.env
) {
  const value = String(
    env.MCP_WEB_MODE || 'active'
  ).trim().toLowerCase()

  if (
    value === 'direct' ||
    value === 'off' ||
    value === 'disabled' ||
    value === '0' ||
    value === 'false' ||
    value === 'shadow'
  ) {
    return 'direct'
  }

  return 'active'
}

function executionConfig(env) {
  return {
    mode: mcpWebExecutionMode(env),
    requestTimeoutMs: positiveInteger(
      env.MCP_WEB_REQUEST_TIMEOUT_MS,
      DEFAULT_REQUEST_TIMEOUT_MS
    ),
    fallbackCooldownMs: positiveInteger(
      env.MCP_WEB_FALLBACK_COOLDOWN_MS,
      DEFAULT_FALLBACK_COOLDOWN_MS
    )
  }
}

function abortError() {
  const error = new Error('Web tool request aborted')
  error.name = 'AbortError'
  return error
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw abortError()
}

function combinedAbortSignal(
  externalSignal,
  timeoutMs
) {
  const controller = new AbortController()
  let timedOut = false

  const onExternalAbort = () => {
    controller.abort(externalSignal?.reason)
  }

  if (externalSignal?.aborted) {
    onExternalAbort()
  } else {
    externalSignal?.addEventListener(
      'abort',
      onExternalAbort,
      { once: true }
    )
  }

  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort(
      new Error('MCP web request timed out')
    )
  }, timeoutMs)

  timeout.unref?.()

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup() {
      clearTimeout(timeout)
      externalSignal?.removeEventListener(
        'abort',
        onExternalAbort
      )
    }
  }
}

function textContent(result) {
  return (result?.content || [])
    .filter(item => item?.type === 'text')
    .map(item => String(item.text || ''))
    .join('\n')
    .trim()
}

function normalizeSearchItems(items) {
  if (!Array.isArray(items)) return []

  return items
    .slice(0, 5)
    .map(item => ({
      title: String(item?.title || ''),
      snippet: String(item?.snippet || ''),
      source: String(item?.source || '')
    }))
}

function formatSearchItems(items) {
  return items.map((item, index) => [
    `[${index + 1}] ${item.title}`,
    item.snippet,
    `Source: ${item.source}`
  ].filter(Boolean).join('\n')).join('\n\n')
}

function sourceUrlsFromText(text) {
  return String(text || '')
    .split('\n')
    .map(line => line.match(/^Source:\s*(https?:\/\/\S+)\s*$/i)?.[1])
    .filter(Boolean)
}

function directSearchResult(result) {
  const items = normalizeSearchItems(
    result?.results
  )

  if (result?.error) {
    return {
      text: `Search error: ${result.error}`,
      error: true,
      resultCount: 0,
      sources: []
    }
  }

  return {
    text: formatSearchItems(items) ||
      'Search error: No results found',
    error: items.length === 0,
    resultCount: items.length,
    sources: items
      .map(item => item.source)
      .filter(Boolean)
  }
}

function directScrapeResult(result, url) {
  if (result?.error) {
    return {
      text: `Scrape error: ${result.error}`,
      error: true
    }
  }

  return {
    text:
      `Content from ${url}:\n\n` +
      String(result?.content || ''),
    error: false
  }
}

function mcpSearchResult(result) {
  const items = normalizeSearchItems(
    result?.structuredContent?.results
  )
  const fallbackText = textContent(result)
  const text = items.length
    ? formatSearchItems(items)
    : fallbackText

  if (!text) {
    throw new Error(
      'MCP web_search returned no usable content'
    )
  }

  const sources = items.length
    ? items.map(item => item.source).filter(Boolean)
    : sourceUrlsFromText(text)

  return {
    text,
    error: result?.isError === true,
    resultCount: items.length ||
      (text.match(/^\[\d+\]/gm)?.length || 0),
    sources
  }
}

function mcpScrapeResult(result, url) {
  const structuredContent =
    result?.structuredContent
  const text = structuredContent &&
    typeof structuredContent.content === 'string'
      ? `Content from ${
          structuredContent.url || url
        }:\n\n${structuredContent.content}`
      : textContent(result)

  if (!text) {
    throw new Error(
      'MCP firecrawl_scrape returned no usable content'
    )
  }

  return {
    text,
    error: result?.isError === true
  }
}

function fallbackLog({
  source,
  tool,
  error,
  reason
}) {
  console.warn(JSON.stringify({
    level: 'warn',
    event: 'mcp_web_fallback',
    source,
    tool,
    reason,
    error: error?.message || String(error || '')
  }))
}

async function callMcpTool(
  name,
  args,
  {
    signal,
    env,
    connectFn,
    timeoutMs
  }
) {
  const linked = combinedAbortSignal(
    signal,
    timeoutMs
  )
  let connection

  try {
    const config = mcpWebConfig(env)

    connection = await connectFn({
      ...config,
      name: `echolink-${name}-runtime`,
      signal: linked.signal
    })

    return await connection.client.callTool(
      {
        name,
        arguments: args
      },
      undefined,
      {
        signal: linked.signal,
        timeout: timeoutMs,
        maxTotalTimeout: timeoutMs
      }
    )
  } catch (error) {
    if (signal?.aborted) throw abortError()

    if (linked.timedOut()) {
      throw new Error(
        `MCP ${name} timed out after ${timeoutMs} ms`
      )
    }

    throw error
  } finally {
    linked.cleanup()
    await connection?.close?.().catch(() => {})
  }
}

async function directSearch(
  query,
  {
    signal,
    searchFn
  }
) {
  assertNotAborted(signal)
  const result = await searchFn(query, signal)
  assertNotAborted(signal)
  return directSearchResult(result)
}

async function directScrape(
  url,
  {
    signal,
    scrapeFn
  }
) {
  assertNotAborted(signal)
  const result = await scrapeFn(url, signal)
  assertNotAborted(signal)
  return directScrapeResult(result, url)
}

export async function executeWebSearch(
  query,
  {
    signal,
    source = 'unknown',
    env = process.env,
    searchFn = webSearch,
    connectFn = connectMcpWebClient,
    now = Date.now
  } = {}
) {
  const normalizedQuery = String(query || '')
    .trim()
    .slice(0, 500)

  if (!normalizedQuery) {
    return {
      text: 'Search error: query is required',
      error: true,
      resultCount: 0,
      sources: [],
      backend: 'validation',
      fallback: false
    }
  }

  const config = executionConfig(env)

  if (config.mode === 'direct') {
    return {
      ...await directSearch(
        normalizedQuery,
        { signal, searchFn }
      ),
      backend: 'direct',
      fallback: false
    }
  }

  if (now() < mcpUnavailableUntil) {
    fallbackLog({
      source,
      tool: 'web_search',
      reason: 'circuit_open',
      error: 'MCP web cooldown is active'
    })

    return {
      ...await directSearch(
        normalizedQuery,
        { signal, searchFn }
      ),
      backend: 'direct',
      fallback: true
    }
  }

  try {
    const result = await callMcpTool(
      'web_search',
      { query: normalizedQuery },
      {
        signal,
        env,
        connectFn,
        timeoutMs: config.requestTimeoutMs
      }
    )

    return {
      ...mcpSearchResult(result),
      backend: 'mcp',
      fallback: false
    }
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') {
      throw abortError()
    }

    mcpUnavailableUntil =
      now() + config.fallbackCooldownMs

    fallbackLog({
      source,
      tool: 'web_search',
      reason: 'mcp_unavailable',
      error
    })

    return {
      ...await directSearch(
        normalizedQuery,
        { signal, searchFn }
      ),
      backend: 'direct',
      fallback: true
    }
  }
}

export async function executeFirecrawlScrape(
  value,
  {
    signal,
    source = 'unknown',
    env = process.env,
    scrapeFn = firecrawlScrape,
    connectFn = connectMcpWebClient,
    publicUrlCheck = assertPublicHttpUrl,
    now = Date.now
  } = {}
) {
  let url

  try {
    url = await publicUrlCheck(value)
  } catch (error) {
    return {
      text: `Scrape blocked: ${error.message}`,
      error: true,
      backend: 'validation',
      fallback: false
    }
  }

  assertNotAborted(signal)
  const config = executionConfig(env)

  if (config.mode === 'direct') {
    return {
      ...await directScrape(
        url,
        { signal, scrapeFn }
      ),
      backend: 'direct',
      fallback: false
    }
  }

  if (now() < mcpUnavailableUntil) {
    fallbackLog({
      source,
      tool: 'firecrawl_scrape',
      reason: 'circuit_open',
      error: 'MCP web cooldown is active'
    })

    return {
      ...await directScrape(
        url,
        { signal, scrapeFn }
      ),
      backend: 'direct',
      fallback: true
    }
  }

  try {
    const result = await callMcpTool(
      'firecrawl_scrape',
      { url },
      {
        signal,
        env,
        connectFn,
        timeoutMs: config.requestTimeoutMs
      }
    )

    return {
      ...mcpScrapeResult(result, url),
      backend: 'mcp',
      fallback: false
    }
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') {
      throw abortError()
    }

    mcpUnavailableUntil =
      now() + config.fallbackCooldownMs

    fallbackLog({
      source,
      tool: 'firecrawl_scrape',
      reason: 'mcp_unavailable',
      error
    })

    return {
      ...await directScrape(
        url,
        { signal, scrapeFn }
      ),
      backend: 'direct',
      fallback: true
    }
  }
}

export function resetMcpWebCircuitForTests() {
  mcpUnavailableUntil = 0
}
