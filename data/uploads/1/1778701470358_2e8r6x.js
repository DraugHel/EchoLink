import * as cheerio from 'cheerio'

const URL_REGEX = /https?:\/\/[^\s)>\]]+/g
const MAX_URLS = 3
const MAX_CONTENT_CHARS = 5000
const FETCH_TIMEOUT_MS = 8000

export function extractUrls(text) {
  const matches = text.match(URL_REGEX) || []
  // Dedupe and limit
  return [...new Set(matches)].slice(0, MAX_URLS)
}

export async function fetchUrlContent(url) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      redirect: 'follow'
    })

    if (!res.ok) return { url, error: `HTTP ${res.status}` }

    const contentType = res.headers.get('content-type') || ''
    if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
      return { url, error: `Unsupported content type: ${contentType.split(';')[0]}` }
    }

    const html = await res.text()
    const $ = cheerio.load(html)

    // Remove script, style, nav, footer, aside
    $('script, style, nav, footer, aside, noscript, iframe').remove()

    const title = $('title').text().trim()
    const body = $('body').text()
      .replace(/\s+/g, ' ')
      .replace(/\n\s*\n/g, '\n\n')
      .trim()

    const truncated = body.length > MAX_CONTENT_CHARS
    const content = body.slice(0, MAX_CONTENT_CHARS)

    return { url, title, content, truncated }
  } catch (err) {
    if (err.name === 'AbortError') return { url, error: 'Timeout' }
    return { url, error: err.message }
  } finally {
    clearTimeout(timeout)
  }
}

export async function fetchAllUrls(urls) {
  return Promise.all(urls.map(fetchUrlContent))
}
