import {
  firecrawlScrape,
  webSearch
} from './webSearch.js'
import {
  executeMcpRegistryTool,
  isMcpCircuitOpen,
  mcpRegistryToolConfig,
  mcpWebExecutionMode,
  recordMcpFallback,
  resetMcpRegistryForTests
} from './mcpRegistry.js'
import { connectMcpWebClient } from './mcpWebClient.js'
import { assertPublicHttpUrl } from '../mcp/publicUrl.js'
import {
  isRedditThreadUrl,
  readRedditThread,
  redditReaderEnabled
} from './redditReader.js'

const MCP_WEB_SERVER = 'mcp-web'

function abortError() {
  const error = new Error('Web tool request aborted')
  error.name = 'AbortError'
  return error
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw abortError()
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

async function useMcpOrFallback({
  toolName,
  args,
  source,
  signal,
  env,
  connectFn,
  now,
  directFn,
  formatMcpResult
}) {
  const tool = mcpRegistryToolConfig(
    MCP_WEB_SERVER,
    toolName,
    env
  )

  if (tool.mode === 'direct') {
    return {
      ...await directFn(),
      backend: 'direct',
      fallback: false
    }
  }

  if (isMcpCircuitOpen(
    MCP_WEB_SERVER,
    { env, now }
  )) {
    assertNotAborted(signal)
    recordMcpFallback(
      MCP_WEB_SERVER,
      toolName,
      {
        source,
        reason: 'circuit_open',
        error: 'MCP web cooldown is active',
        env
      }
    )

    return {
      ...await directFn(),
      backend: 'direct',
      fallback: true
    }
  }

  try {
    const result = await executeMcpRegistryTool(
      MCP_WEB_SERVER,
      toolName,
      args,
      {
        signal,
        env,
        connectFn,
        source,
        now
      }
    )

    return {
      ...formatMcpResult(result),
      backend: 'mcp',
      fallback: false
    }
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') {
      throw abortError()
    }

    recordMcpFallback(
      MCP_WEB_SERVER,
      toolName,
      {
        source,
        reason: error?.name ===
          'McpRegistryCircuitOpenError'
            ? 'circuit_open'
            : 'mcp_unavailable',
        error,
        env
      }
    )

    return {
      ...await directFn(),
      backend: 'direct',
      fallback: true
    }
  }
}

export { mcpWebExecutionMode }

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

  return useMcpOrFallback({
    toolName: 'web_search',
    args: { query: normalizedQuery },
    source,
    signal,
    env,
    connectFn,
    now,
    directFn: () => directSearch(
      normalizedQuery,
      { signal, searchFn }
    ),
    formatMcpResult: mcpSearchResult
  })
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
    redditFn = readRedditThread,
    redditUrlCheck = isRedditThreadUrl,
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

  if (
    redditReaderEnabled(env) &&
    redditUrlCheck(url)
  ) {
    const result = await redditFn(
      url,
      { signal, env }
    )
    assertNotAborted(signal)

    return {
      text: result?.error
        ? `Reddit error: ${result.error}`
        : `Content from ${
            result.url || url
          }:\n\n${String(result.content || '')}`,
      error: Boolean(result?.error),
      backend: 'reddit-oauth',
      fallback: false
    }
  }

  return useMcpOrFallback({
    toolName: 'firecrawl_scrape',
    args: { url },
    source,
    signal,
    env,
    connectFn,
    now,
    directFn: () => directScrape(
      url,
      { signal, scrapeFn }
    ),
    formatMcpResult: result =>
      mcpScrapeResult(result, url)
  })
}

export function resetMcpWebCircuitForTests() {
  resetMcpRegistryForTests()
}
