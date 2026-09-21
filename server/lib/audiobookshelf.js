const DEFAULT_TIMEOUT_MS = 15_000
const MAX_PAGE_SIZE = 100
const MAX_UPDATES = 25
const ID_PATTERN = /^[A-Za-z0-9_-]{3,160}$/

const STRING_FIELDS = new Map([
  ['title', 500],
  ['subtitle', 500],
  ['publishedYear', 16],
  ['publishedDate', 32],
  ['publisher', 500],
  ['description', 20_000],
  ['isbn', 64],
  ['asin', 64],
  ['language', 64]
])

const ARRAY_STRING_FIELDS = new Map([
  ['narrators', 50],
  ['genres', 50]
])

function exposedError(message, statusCode = 400, code = 'AUDIOBOOKSHELF_INVALID_REQUEST') {
  const error = new Error(message)
  error.statusCode = statusCode
  error.code = code
  error.expose = true
  return error
}

function cleanBaseUrl(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    throw exposedError(
      'AUDIOBOOKSHELF_URL ist keine gueltige URL',
      503,
      'AUDIOBOOKSHELF_CONFIG_INVALID'
    )
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw exposedError(
      'AUDIOBOOKSHELF_URL muss http oder https verwenden',
      503,
      'AUDIOBOOKSHELF_CONFIG_INVALID'
    )
  }
  parsed.hash = ''
  parsed.search = ''
  return parsed.toString().replace(/\/$/, '')
}

export function audiobookshelfConfig(env = process.env) {
  const baseUrl = cleanBaseUrl(env.AUDIOBOOKSHELF_URL)
  const apiKey = String(env.AUDIOBOOKSHELF_API_KEY || '').trim()
  return {
    configured: Boolean(baseUrl && apiKey),
    baseUrl,
    apiKey,
    timeoutMs: Number.isFinite(Number(env.AUDIOBOOKSHELF_TIMEOUT_MS))
      ? Math.max(1_000, Math.min(60_000, Number(env.AUDIOBOOKSHELF_TIMEOUT_MS)))
      : DEFAULT_TIMEOUT_MS
  }
}

export function assertAudiobookshelfId(value, label = 'id') {
  const normalized = String(value || '').trim()
  if (!ID_PATTERN.test(normalized)) {
    throw exposedError(`Ungueltige Audiobookshelf-${label}`)
  }
  return normalized
}

function nullableString(value, maxLength, field) {
  if (value === null) return null
  if (typeof value !== 'string') {
    throw exposedError(`${field} muss ein String oder null sein`)
  }
  const normalized = value.trim()
  if (normalized.length > maxLength) {
    throw exposedError(`${field} ist zu lang`)
  }
  return normalized || null
}

function stringArray(value, field, maxItems) {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw exposedError(`${field} muss ein Array mit maximal ${maxItems} Eintraegen sein`)
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string') {
      throw exposedError(`${field}[${index}] muss ein String sein`)
    }
    const normalized = entry.trim()
    if (!normalized || normalized.length > 300) {
      throw exposedError(`${field}[${index}] ist leer oder zu lang`)
    }
    return normalized
  })
}

function authorArray(value) {
  if (!Array.isArray(value) || value.length > 20) {
    throw exposedError('authors muss ein Array mit maximal 20 Eintraegen sein')
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw exposedError(`authors[${index}] muss ein Objekt sein`)
    }
    const keys = Object.keys(entry)
    if (keys.some(key => key !== 'name')) {
      throw exposedError(`authors[${index}] enthaelt nicht erlaubte Felder`)
    }
    const name = nullableString(entry.name, 300, `authors[${index}].name`)
    if (!name) throw exposedError(`authors[${index}].name darf nicht leer sein`)
    return { name }
  })
}

function seriesArray(value) {
  if (!Array.isArray(value) || value.length > 20) {
    throw exposedError('series muss ein Array mit maximal 20 Eintraegen sein')
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw exposedError(`series[${index}] muss ein Objekt sein`)
    }
    const keys = Object.keys(entry)
    if (keys.some(key => !['name', 'sequence'].includes(key))) {
      throw exposedError(`series[${index}] enthaelt nicht erlaubte Felder`)
    }
    const name = nullableString(entry.name, 300, `series[${index}].name`)
    if (!name) throw exposedError(`series[${index}].name darf nicht leer sein`)
    return {
      name,
      sequence: entry.sequence === undefined
        ? null
        : nullableString(entry.sequence, 40, `series[${index}].sequence`)
    }
  })
}

export function sanitizeBookMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw exposedError('metadata muss ein Objekt sein')
  }

  const allowed = new Set([
    ...STRING_FIELDS.keys(),
    ...ARRAY_STRING_FIELDS.keys(),
    'authors',
    'series',
    'explicit'
  ])
  const keys = Object.keys(value)
  if (!keys.length) throw exposedError('metadata darf nicht leer sein')
  if (keys.some(key => !allowed.has(key))) {
    throw exposedError('metadata enthaelt nicht erlaubte Felder')
  }

  const output = {}
  for (const [field, maxLength] of STRING_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(value, field)) {
      output[field] = nullableString(value[field], maxLength, field)
    }
  }
  for (const [field, maxItems] of ARRAY_STRING_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(value, field)) {
      output[field] = stringArray(value[field], field, maxItems)
    }
  }
  if (Object.prototype.hasOwnProperty.call(value, 'authors')) {
    output.authors = authorArray(value.authors)
  }
  if (Object.prototype.hasOwnProperty.call(value, 'series')) {
    output.series = seriesArray(value.series)
  }
  if (Object.prototype.hasOwnProperty.call(value, 'explicit')) {
    if (typeof value.explicit !== 'boolean') {
      throw exposedError('explicit muss true oder false sein')
    }
    output.explicit = value.explicit
  }

  return output
}

export function normalizeAudiobookshelfUpdates(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw exposedError('Request-Body muss ein Objekt sein')
  }
  const keys = Object.keys(body)
  if (keys.some(key => key !== 'updates')) {
    throw exposedError('Request-Body enthaelt nicht erlaubte Felder')
  }
  if (!Array.isArray(body.updates) || !body.updates.length || body.updates.length > MAX_UPDATES) {
    throw exposedError(`updates muss 1 bis ${MAX_UPDATES} Eintraege enthalten`)
  }

  const seen = new Set()
  return body.updates.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw exposedError(`updates[${index}] muss ein Objekt sein`)
    }
    const entryKeys = Object.keys(entry)
    if (entryKeys.some(key => !['id', 'expectedUpdatedAt', 'metadata'].includes(key))) {
      throw exposedError(`updates[${index}] enthaelt nicht erlaubte Felder`)
    }
    const id = assertAudiobookshelfId(entry.id, 'item-id')
    if (seen.has(id)) throw exposedError(`Doppelte Item-ID: ${id}`)
    seen.add(id)
    if (!Number.isSafeInteger(entry.expectedUpdatedAt) || entry.expectedUpdatedAt < 0) {
      throw exposedError(`updates[${index}].expectedUpdatedAt muss gesetzt sein`)
    }
    return {
      id,
      expectedUpdatedAt: entry.expectedUpdatedAt,
      metadata: sanitizeBookMetadata(entry.metadata)
    }
  })
}

export function compactAudiobookshelfItem(item) {
  const metadata = item?.media?.metadata || {}
  return {
    id: item?.id || null,
    libraryId: item?.libraryId || null,
    relPath: item?.relPath || null,
    updatedAt: Number.isSafeInteger(item?.updatedAt) ? item.updatedAt : null,
    isMissing: Boolean(item?.isMissing),
    isInvalid: Boolean(item?.isInvalid),
    mediaType: item?.mediaType || null,
    metadata: {
      title: metadata.title ?? null,
      subtitle: metadata.subtitle ?? null,
      authors: Array.isArray(metadata.authors)
        ? metadata.authors.map(author => ({ name: author?.name || '' })).filter(author => author.name)
        : undefined,
      authorName: metadata.authorName,
      narrators: Array.isArray(metadata.narrators) ? metadata.narrators : undefined,
      narratorName: metadata.narratorName,
      series: Array.isArray(metadata.series)
        ? metadata.series.map(series => ({
            name: series?.name || '',
            sequence: series?.sequence ?? null
          })).filter(series => series.name)
        : undefined,
      seriesName: metadata.seriesName,
      genres: Array.isArray(metadata.genres) ? metadata.genres : [],
      publishedYear: metadata.publishedYear ?? null,
      publishedDate: metadata.publishedDate ?? null,
      publisher: metadata.publisher ?? null,
      description: metadata.description ?? null,
      isbn: metadata.isbn ?? null,
      asin: metadata.asin ?? null,
      language: metadata.language ?? null,
      explicit: metadata.explicit ?? false
    },
    tags: Array.isArray(item?.media?.tags) ? item.media.tags : []
  }
}

function compactListItem(item) {
  const compact = compactAudiobookshelfItem(item)
  if (compact.metadata.description) {
    compact.metadata.description = compact.metadata.description.slice(0, 500)
  }
  return compact
}

export function createAudiobookshelfClient({
  baseUrl,
  apiKey,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch
}) {
  if (!baseUrl || !apiKey) {
    throw exposedError(
      'Audiobookshelf ist nicht konfiguriert',
      503,
      'AUDIOBOOKSHELF_NOT_CONFIGURED'
    )
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch implementation missing')
  }

  async function request(pathname, { method = 'GET', body } = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    timer.unref?.()
    try {
      const response = await fetchImpl(`${baseUrl}${pathname}`, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      })
      const text = await response.text()
      let payload = null
      if (text) {
        try { payload = JSON.parse(text) } catch { payload = { raw: text.slice(0, 1000) } }
      }
      if (!response.ok) {
        const error = new Error(`Audiobookshelf HTTP ${response.status}`)
        error.code = 'AUDIOBOOKSHELF_UPSTREAM_ERROR'
        error.statusCode = 502
        error.upstreamStatus = response.status
        error.upstreamBody = payload
        throw error
      }
      return payload
    } catch (error) {
      if (error?.name === 'AbortError') {
        const timeout = new Error('Audiobookshelf request timed out')
        timeout.code = 'AUDIOBOOKSHELF_TIMEOUT'
        timeout.statusCode = 504
        throw timeout
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    async listLibraries() {
      const payload = await request('/api/libraries')
      const libraries = Array.isArray(payload?.libraries) ? payload.libraries : []
      return libraries.map(library => ({
        id: library.id,
        name: library.name,
        mediaType: library.mediaType,
        provider: library.provider
      }))
    },

    async listItems(libraryId, { limit = 50, page = 0 } = {}) {
      const id = assertAudiobookshelfId(libraryId, 'library-id')
      const safeLimit = Math.max(1, Math.min(MAX_PAGE_SIZE, Number(limit) || 50))
      const safePage = Math.max(0, Math.min(100_000, Number(page) || 0))
      const query = new URLSearchParams({
        limit: String(safeLimit),
        page: String(safePage),
        sort: 'media.metadata.title',
        desc: '0',
        minified: '0',
        collapseseries: '0'
      })
      const payload = await request(`/api/libraries/${encodeURIComponent(id)}/items?${query}`)
      return {
        total: Number(payload?.total) || 0,
        limit: Number(payload?.limit) || safeLimit,
        page: Number(payload?.page) || safePage,
        results: Array.isArray(payload?.results)
          ? payload.results.map(compactListItem)
          : []
      }
    },

    async getItem(itemId) {
      const id = assertAudiobookshelfId(itemId, 'item-id')
      return compactAudiobookshelfItem(
        await request(`/api/items/${encodeURIComponent(id)}`)
      )
    },

    async updateItemMetadata(itemId, metadata) {
      const id = assertAudiobookshelfId(itemId, 'item-id')
      const clean = sanitizeBookMetadata(metadata)
      return compactAudiobookshelfItem(
        await request(`/api/items/${encodeURIComponent(id)}/media`, {
          method: 'PATCH',
          body: { metadata: clean }
        })
      )
    }
  }
}
