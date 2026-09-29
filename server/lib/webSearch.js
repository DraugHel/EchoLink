const SEARXNG_URL = process.env.SEARXNG_URL || 'http://localhost:8080'
const FIRECRAWL_URL = process.env.FIRECRAWL_URL || 'http://localhost:3002'
const BRAVE_SEARCH_URL =
  'https://api.search.brave.com/res/v1/web/search'
const SEARCH_TIMEOUT_MS = positiveInt(
  process.env.SEARXNG_SEARCH_TIMEOUT_MS,
  18000
)
const BRAVE_TIMEOUT_MS = positiveInt(
  process.env.BRAVE_SEARCH_TIMEOUT_MS,
  10000
)
const BRAVE_RETRY_MAX_MS = 3000
const BRAVE_RETRY_DEFAULT_MS = 1100
const MAX_RESULTS = 5

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : fallback
}

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

const HTML_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' '
}

// Brave liefert Titel und Beschreibung mit HTML (<strong>, &#x27; usw.).
function plainText(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
      const lower = entity.toLowerCase()

      if (lower[0] === '#') {
        const code = lower[1] === 'x'
          ? Number.parseInt(lower.slice(2), 16)
          : Number.parseInt(lower.slice(1), 10)

        return Number.isFinite(code) &&
          code > 0 &&
          code <= 0x10ffff
          ? String.fromCodePoint(code)
          : match
      }

      return HTML_ENTITIES[lower] ?? match
    })
    .replace(/\s+/g, ' ')
    .trim()
}

function sleep(ms, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve()

    const finish = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)

    signal?.addEventListener('abort', finish, { once: true })
  })
}

// Brave erlaubt maximal 600 Zeichen und 75 Woerter pro Anfrage.
function braveQuery(query) {
  return String(query || '')
    .trim()
    .split(/\s+/)
    .slice(0, 75)
    .join(' ')
    .slice(0, 600)
}

function braveResults(data) {
  const items = Array.isArray(data?.web?.results)
    ? data.web.results
    : []

  return items
    .map(item => ({
      title: plainText(item?.title).slice(0, 300),
      snippet: plainText(item?.description).slice(0, 600),
      source: typeof item?.url === 'string'
        ? item.url.trim()
        : ''
    }))
    .filter(item => /^https?:\/\//i.test(item.source))
    .slice(0, MAX_RESULTS)
}

async function braveRequest(url, headers, abortSignal, fetchFn) {
  const { controller, cleanup } =
    linkedAbortController(abortSignal, BRAVE_TIMEOUT_MS)

  try {
    const res = await fetchFn(url, {
      headers,
      signal: controller.signal
    })

    if (!res.ok) {
      return {
        status: res.status,
        retryAfter: res.headers?.get?.('retry-after')
      }
    }

    return { status: res.status, data: await res.json() }
  } finally {
    cleanup()
  }
}

// Kurz warten und einmal wiederholen, wenn Brave wegen Anfragetempo
// (429) ablehnt. Lange Sperren (z.B. aufgebrauchtes Guthaben) nicht.
function retryDelayMs(retryAfter) {
  const seconds = Number(retryAfter)
  const delay = Number.isFinite(seconds) && seconds > 0
    ? seconds * 1000
    : BRAVE_RETRY_DEFAULT_MS

  return delay <= BRAVE_RETRY_MAX_MS ? delay : null
}

async function braveSearch(query, abortSignal, { env, fetchFn }) {
  const url = new URL(BRAVE_SEARCH_URL)
  url.searchParams.set('q', braveQuery(query))
  url.searchParams.set('count', String(MAX_RESULTS))

  const headers = {
    Accept: 'application/json',
    'X-Subscription-Token': String(env.BRAVE_API_KEY).trim()
  }

  try {
    let response = await braveRequest(
      url,
      headers,
      abortSignal,
      fetchFn
    )

    if (response.status === 429) {
      const delay = retryDelayMs(response.retryAfter)

      if (delay !== null) {
        await sleep(delay, abortSignal)

        if (!abortSignal?.aborted) {
          response = await braveRequest(
            url,
            headers,
            abortSignal,
            fetchFn
          )
        }
      }
    }

    if (!response.data) {
      return { error: `HTTP ${response.status}` }
    }

    return { results: braveResults(response.data) }
  } catch (err) {
    return {
      error: err?.name === 'AbortError'
        ? 'timeout'
        : String(err?.message || err)
    }
  }
}

async function searxngSearch(query, abortSignal, fetchFn) {
  const { controller, cleanup } =
    linkedAbortController(
      abortSignal,
      SEARCH_TIMEOUT_MS
    )
  try {
    const url = `${SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json&categories=general`
    const res = await fetchFn(url, { signal: controller.signal })
    if (!res.ok) return { error: `Search failed: HTTP ${res.status}` }
    const data = await res.json()
    const results = (data.results || []).slice(0, MAX_RESULTS).map(r => ({
      title: r.title || '',
      snippet: r.content || '',
      source: r.url || ''
    }))
    if (results.length === 0) return { error: 'No results found', query }
    return { query, results, engine: 'searxng' }
  } catch (err) {
    if (err.name === 'AbortError') return { error: 'Search timeout', query }
    return { error: err.message, query }
  } finally {
    cleanup()
  }
}

// Ist BRAVE_API_KEY gesetzt, wird Brave zuerst benutzt (Rechenzentrums-IPs
// wie Hetzner werden von Google/Bing & Co. blockiert, die API nicht).
// SearXNG bleibt Fallback bei Fehlern. Ohne Key aendert sich nichts.
export async function webSearch(
  query,
  abortSignal,
  {
    env = process.env,
    fetchFn = globalThis.fetch
  } = {}
) {
  let braveError = ''

  if (String(env.BRAVE_API_KEY || '').trim()) {
    const brave = await braveSearch(
      query,
      abortSignal,
      { env, fetchFn }
    )

    if (brave.results) {
      return brave.results.length
        ? { query, results: brave.results, engine: 'brave' }
        : { error: 'No results found', query }
    }

    if (abortSignal?.aborted) {
      return { error: 'Search timeout', query }
    }

    braveError = brave.error
    console.warn(JSON.stringify({
      level: 'warn',
      event: 'brave_search_failed',
      error: braveError
    }))
  }

  const fallback = await searxngSearch(
    query,
    abortSignal,
    fetchFn
  )

  if (fallback.error && braveError) {
    return {
      ...fallback,
      error: `Brave: ${braveError}; SearXNG: ${fallback.error}`
    }
  }

  return fallback
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
