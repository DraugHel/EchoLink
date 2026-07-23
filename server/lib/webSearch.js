const SEARXNG_URL = process.env.SEARXNG_URL || 'http://localhost:8080'
const FIRECRAWL_URL = process.env.FIRECRAWL_URL || 'http://localhost:3002'
const SEARCH_TIMEOUT_MS = 10000
const MAX_RESULTS = 5

function linkedAbortController(externalSignal, timeoutMs) {
  const controller = new AbortController()

  const onExternalAbort = () => controller.abort()

  if (externalSignal?.aborted) {
    controller.abort()
  } else {
    externalSignal?.addEventListener(
      'abort',
      onExternalAbort,
      { once: true }
    )
  }

  const timeout = setTimeout(
    () => controller.abort(),
    timeoutMs
  )

  return {
    controller,
    cleanup() {
      clearTimeout(timeout)
      externalSignal?.removeEventListener(
        'abort',
        onExternalAbort
      )
    }
  }
}

export async function webSearch(query, abortSignal) {
  const { controller, cleanup } =
    linkedAbortController(
      abortSignal,
      SEARCH_TIMEOUT_MS
    )
  try {
    const url = `${SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json&categories=general`
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) return { error: `Search failed: HTTP ${res.status}` }
    const data = await res.json()
    const results = (data.results || []).slice(0, MAX_RESULTS).map(r => ({
      title: r.title || '',
      snippet: r.content || '',
      source: r.url || ''
    }))
    if (results.length === 0) return { error: 'No results found', query }
    return { query, results }
  } catch (err) {
    if (err.name === 'AbortError') return { error: 'Search timeout', query }
    return { error: err.message, query }
  } finally {
    cleanup()
  }
}

export async function firecrawlScrape(url, abortSignal) {
  const { controller, cleanup } =
    linkedAbortController(abortSignal, 15000)
  try {
    const res = await fetch(`${FIRECRAWL_URL}/v1/scrape`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, formats: ['markdown'] })
    })
    if (!res.ok) return { error: `Firecrawl failed: HTTP ${res.status}` }
    const data = await res.json()
    const md = data?.data?.markdown || ''
    return { url, content: md.slice(0, 8000) }
  } catch (err) {
    if (err.name === 'AbortError') return { error: 'Scrape timeout', url }
    return { error: err.message, url }
  } finally {
    cleanup()
  }
}

export const SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Search the web for current information, recent events, or facts. Use when the user asks about current events, recent developments, or anything requiring up-to-date information.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query — specific and concise'
        }
      },
      required: ['query']
    }
  }
}

export const FIRECRAWL_TOOL = {
  type: 'function',
  function: {
    name: 'firecrawl_scrape',
    description: 'Fetch and read the full content of a specific webpage or URL. Reddit thread links are read through the configured read-only Reddit OAuth API; other pages use the web scraper. Use this when you need to read an article, documentation, Reddit discussion, or any webpage in detail.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The full URL to scrape and read'
        }
      },
      required: ['url']
    }
  }
}

export const TERMINAL_TOOL = {
  type: 'function',
  function: {
    name: 'terminal',
    description: 'Execute a shell command on the server. Use for checking server status, restarting services, reading logs, running builds, git operations, or any server administration task. Always prefer safe read-only commands first.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute'
        },
        description: {
          type: 'string',
          description: 'Brief human-readable description of what this command does and why'
        }
      },
      required: ['command', 'description']
    }
  }
}
