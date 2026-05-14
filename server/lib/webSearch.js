import * as cheerio from 'cheerio'

const SEARCH_TIMEOUT_MS = 10000
const MAX_RESULTS = 5

export async function webSearch(query) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS)

  try {
    // DuckDuckGo HTML endpoint — no API key needed
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
      }
    })

    if (!res.ok) return { error: `Search failed: HTTP ${res.status}` }

    const html = await res.text()
    const $ = cheerio.load(html)

    const results = []
    $('.result').each((i, el) => {
      if (results.length >= MAX_RESULTS) return false
      const title = $(el).find('.result__title').text().trim()
      const snippet = $(el).find('.result__snippet').text().trim()
      const linkRaw = $(el).find('.result__url').text().trim()
      if (title && snippet) {
        results.push({ title, snippet, source: linkRaw })
      }
    })

    if (results.length === 0) return { error: 'No results found', query }
    return { query, results }
  } catch (err) {
    if (err.name === 'AbortError') return { error: 'Search timeout', query }
    return { error: err.message, query }
  } finally {
    clearTimeout(timeout)
  }
}

// Tool definition for Ollama
export const SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Search the web for current information, recent events, or facts that may not be in your training data. Use this when the user asks about current events, recent developments, specific facts you are not sure about, or anything that requires up-to-date information.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query — be specific and concise, like you would type into a search engine'
        }
      },
      required: ['query']
    }
  }
}
