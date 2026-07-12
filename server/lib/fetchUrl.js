import * as cheerio from 'cheerio'
import dns from 'node:dns/promises'
import net from 'node:net'

const URL_REGEX = /https?:\/\/[^\s)>\]]+/g
const MAX_URLS = 3
const MAX_CONTENT_CHARS = 5000
const FETCH_TIMEOUT_MS = 8000
const MAX_REDIRECTS = 5

function isPrivateIp(ip) {
  const normalized = ip.toLowerCase().split('%')[0]

  if (net.isIPv4(normalized)) {
    const [a, b] = normalized.split('.').map(Number)

    return a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
  }

  if (net.isIPv6(normalized)) {
    return normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      /^fe[89ab]/.test(normalized) ||
      normalized.startsWith('ff') ||
      normalized.startsWith('2001:db8:') ||
      normalized.startsWith('::ffff:127.') ||
      normalized.startsWith('::ffff:10.') ||
      normalized.startsWith('::ffff:192.168.') ||
      /^::ffff:172\.(1[6-9]|2\d|3[01])\./.test(normalized)
  }

  // Unbekannte oder ungueltige Adresstypen sicherheitshalber blockieren.
  return true
}

async function assertSafeUrl(rawUrl) {
  let parsed

  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error('Invalid URL')
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only HTTP(S) URLs are allowed')
  }

  if (parsed.username || parsed.password) {
    throw new Error('URL credentials are not allowed')
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '')

  if (
    !hostname ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local')
  ) {
    throw new Error('Local hosts are blocked')
  }

  let addresses

  try {
    addresses = net.isIP(hostname)
      ? [{ address: hostname }]
      : await dns.lookup(hostname, { all: true, verbatim: true })
  } catch {
    throw new Error('Hostname could not be resolved')
  }

  if (
    !addresses.length ||
    addresses.some(({ address }) => isPrivateIp(address))
  ) {
    throw new Error('Private or reserved network targets are blocked')
  }

  return parsed
}

async function safeFetch(rawUrl, options) {
  let current = rawUrl

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    await assertSafeUrl(current)

    const res = await fetch(current, {
      ...options,
      redirect: 'manual'
    })

    if (![301, 302, 303, 307, 308].includes(res.status)) {
      return { res, finalUrl: current }
    }

    const location = res.headers.get('location')

    if (!location) {
      throw new Error('Redirect without Location header')
    }

    if (redirects === MAX_REDIRECTS) {
      throw new Error('Too many redirects')
    }

    current = new URL(location, current).href
  }

  throw new Error('Too many redirects')
}

export function extractUrls(text) {
  const matches = text.match(URL_REGEX) || []
  // Dedupe and limit
  return [...new Set(matches)].slice(0, MAX_URLS)
}

export async function fetchUrlContent(url) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    const { res, finalUrl } = await safeFetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
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

    return { url: finalUrl, title, content, truncated }
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
