import {
  assertAudiobookshelfId,
  audiobookshelfConfig,
  normalizeAudiobookshelfUpdates
} from './audiobookshelf.js'

const LOCAL_TIMEOUT_MS = 20_000

const TOOL_STATUS = {
  type: 'function',
  function: {
    name: 'audiobookshelf_status',
    description:
      'Check whether the configured Audiobookshelf server is reachable and list its libraries. Read-only.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  }
}

const TOOL_LIST_LIBRARIES = {
  type: 'function',
  function: {
    name: 'audiobookshelf_list_libraries',
    description:
      'List Audiobookshelf libraries available to EchoLink. Read-only. Use this before inspecting a library when its ID is unknown.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  }
}

const TOOL_LIST_ITEMS = {
  type: 'function',
  function: {
    name: 'audiobookshelf_list_items',
    description:
      'Read one page of compact Audiobookshelf library items including path, metadata and updatedAt. Read-only. For a full audit continue page by page until all total items were inspected.',
    parameters: {
      type: 'object',
      properties: {
        libraryId: {
          type: 'string',
          description: 'Audiobookshelf library ID.'
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'Items per page. Prefer 50 for library audits.'
        },
        page: {
          type: 'integer',
          minimum: 0,
          maximum: 100000,
          description: 'Zero-based page number.'
        }
      },
      required: ['libraryId'],
      additionalProperties: false
    }
  }
}

const TOOL_GET_ITEM = {
  type: 'function',
  function: {
    name: 'audiobookshelf_get_item',
    description:
      'Read one Audiobookshelf item with compact metadata and updatedAt. Read-only. Re-read items before proposing metadata changes.',
    parameters: {
      type: 'object',
      properties: {
        itemId: {
          type: 'string',
          description: 'Audiobookshelf item ID.'
        }
      },
      required: ['itemId'],
      additionalProperties: false
    }
  }
}

const metadataProperties = {
  title: { type: ['string', 'null'] },
  subtitle: { type: ['string', 'null'] },
  authors: {
    type: 'array',
    maxItems: 20,
    items: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false
    }
  },
  narrators: {
    type: 'array',
    maxItems: 50,
    items: { type: 'string' }
  },
  series: {
    type: 'array',
    maxItems: 20,
    items: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        sequence: { type: ['string', 'null'] }
      },
      required: ['name'],
      additionalProperties: false
    }
  },
  genres: {
    type: 'array',
    maxItems: 50,
    items: { type: 'string' }
  },
  publishedYear: { type: ['string', 'null'] },
  publishedDate: { type: ['string', 'null'] },
  publisher: { type: ['string', 'null'] },
  description: { type: ['string', 'null'] },
  isbn: { type: ['string', 'null'] },
  asin: { type: ['string', 'null'] },
  language: { type: ['string', 'null'] },
  explicit: { type: 'boolean' }
}

const TOOL_UPDATE_METADATA = {
  type: 'function',
  function: {
    name: 'audiobookshelf_update_metadata',
    description:
      'Prepare a write approval for 1-25 Audiobookshelf book metadata updates. The app displays an exact old-to-new preview and applies nothing until the user clicks Approve. Never use this merely to create a dry-run; first show the proposed plan in normal chat, then call this tool only after the user explicitly asks to apply that shown plan. Files and folders are never renamed or moved.',
    parameters: {
      type: 'object',
      properties: {
        updates: {
          type: 'array',
          minItems: 1,
          maxItems: 25,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              expectedUpdatedAt: {
                type: 'integer',
                minimum: 0,
                description:
                  'Exact updatedAt from the latest item read. Prevents stale writes.'
              },
              metadata: {
                type: 'object',
                properties: metadataProperties,
                additionalProperties: false
              }
            },
            required: ['id', 'expectedUpdatedAt', 'metadata'],
            additionalProperties: false
          }
        }
      },
      required: ['updates'],
      additionalProperties: false
    }
  }
}

export const AUDIOBOOKSHELF_TOOLS = [
  TOOL_STATUS,
  TOOL_LIST_LIBRARIES,
  TOOL_LIST_ITEMS,
  TOOL_GET_ITEM,
  TOOL_UPDATE_METADATA
]

export const AUDIOBOOKSHELF_TOOL_NAMES = new Set(
  AUDIOBOOKSHELF_TOOLS.map(tool => tool.function.name)
)

export const AUDIOBOOKSHELF_WRITE_TOOL_NAMES = new Set([
  'audiobookshelf_update_metadata'
])

function toolError(message, code = 'AUDIOBOOKSHELF_TOOL_ERROR', statusCode = 400) {
  const error = new Error(message)
  error.code = code
  error.statusCode = statusCode
  return error
}

function localPort(env) {
  const value = Number(env.PORT || 3000)
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw toolError(
      'EchoLink PORT ist fuer Audiobookshelf-Tools ungueltig',
      'AUDIOBOOKSHELF_TOOL_CONFIG_INVALID',
      503
    )
  }
  return value
}

function localAdapterConfig(env = process.env) {
  const upstream = audiobookshelfConfig(env)
  const echoApiKey = String(env.ECHO_API_KEY || '').trim()
  return {
    configured: upstream.configured && Boolean(echoApiKey),
    echoApiKey,
    baseUrl: `http://127.0.0.1:${localPort(env)}/api/audiobookshelf`
  }
}

export function audiobookshelfToolsEnabled(env = process.env) {
  try {
    return localAdapterConfig(env).configured
  } catch {
    return false
  }
}

async function readPayload(response) {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text.slice(0, 1000) }
  }
}

async function localRequest(
  pathname,
  {
    method = 'GET',
    body,
    signal,
    fetchImpl = globalThis.fetch,
    env = process.env
  } = {}
) {
  const config = localAdapterConfig(env)
  if (!config.configured) {
    throw toolError(
      'Audiobookshelf-Tools sind nicht konfiguriert',
      'AUDIOBOOKSHELF_TOOL_NOT_CONFIGURED',
      503
    )
  }
  if (typeof fetchImpl !== 'function') {
    throw toolError('fetch implementation missing')
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), LOCAL_TIMEOUT_MS)
  timer.unref?.()
  const onAbort = () => controller.abort()
  signal?.addEventListener?.('abort', onAbort, { once: true })

  try {
    const response = await fetchImpl(
      `${config.baseUrl}${pathname}`,
      {
        method,
        headers: {
          'X-Echo-Api-Key': config.echoApiKey,
          Accept: 'application/json',
          ...(body === undefined
            ? {}
            : { 'Content-Type': 'application/json' })
        },
        body: body === undefined
          ? undefined
          : JSON.stringify(body),
        signal: controller.signal
      }
    )
    const payload = await readPayload(response)
    if (!response.ok) {
      const error = toolError(
        payload?.error || `Audiobookshelf adapter HTTP ${response.status}`,
        payload?.code || 'AUDIOBOOKSHELF_ADAPTER_ERROR',
        response.status
      )
      error.details = payload
      throw error
    }
    return payload
  } catch (error) {
    if (error?.name === 'AbortError') {
      if (signal?.aborted) throw error
      throw toolError(
        'Audiobookshelf adapter timed out',
        'AUDIOBOOKSHELF_TOOL_TIMEOUT',
        504
      )
    }
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }
}

function jsonResult(value) {
  return JSON.stringify(value)
}

export async function executeAudiobookshelfTool(
  name,
  args = {},
  context = {}
) {
  if (!AUDIOBOOKSHELF_TOOL_NAMES.has(name)) {
    throw toolError(`Unbekanntes Audiobookshelf-Tool: ${name}`)
  }

  if (name === 'audiobookshelf_status') {
    return jsonResult(
      await localRequest('/status', context)
    )
  }

  if (name === 'audiobookshelf_list_libraries') {
    return jsonResult(
      await localRequest('/libraries', context)
    )
  }

  if (name === 'audiobookshelf_list_items') {
    const libraryId = assertAudiobookshelfId(
      args.libraryId,
      'library-id'
    )
    const limit = Number.isInteger(args.limit)
      ? Math.max(1, Math.min(100, args.limit))
      : 50
    const page = Number.isInteger(args.page)
      ? Math.max(0, Math.min(100000, args.page))
      : 0
    const query = new URLSearchParams({
      limit: String(limit),
      page: String(page)
    })
    return jsonResult(
      await localRequest(
        `/libraries/${encodeURIComponent(libraryId)}/items?${query}`,
        context
      )
    )
  }

  if (name === 'audiobookshelf_get_item') {
    const itemId = assertAudiobookshelfId(args.itemId, 'item-id')
    return jsonResult(
      await localRequest(
        `/items/${encodeURIComponent(itemId)}`,
        context
      )
    )
  }

  if (name === 'audiobookshelf_update_metadata') {
    const updates = normalizeAudiobookshelfUpdates({
      updates: args.updates
    })
    return jsonResult(
      await localRequest('/apply', {
        ...context,
        method: 'POST',
        body: { updates }
      })
    )
  }

  throw toolError(`Unbekanntes Audiobookshelf-Tool: ${name}`)
}

function metadataBeforeValue(item, field) {
  const metadata = item?.metadata || {}
  if (field === 'authors') {
    if (Array.isArray(metadata.authors)) return metadata.authors
    return metadata.authorName
      ? [{ name: metadata.authorName }]
      : []
  }
  if (field === 'narrators') {
    if (Array.isArray(metadata.narrators)) return metadata.narrators
    return metadata.narratorName
      ? [metadata.narratorName]
      : []
  }
  if (field === 'series') {
    if (Array.isArray(metadata.series)) return metadata.series
    return metadata.seriesName
      ? [{ name: metadata.seriesName, sequence: null }]
      : []
  }
  return metadata[field] ?? null
}

function sameValue(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}

function shortValue(value) {
  let text
  if (Array.isArray(value)) {
    text = value.map(entry => {
      if (typeof entry === 'string') return entry
      if (entry?.name && entry?.sequence) {
        return `${entry.name} #${entry.sequence}`
      }
      return entry?.name || JSON.stringify(entry)
    }).join(', ')
  } else if (value === null || value === undefined || value === '') {
    text = '—'
  } else if (typeof value === 'boolean') {
    text = value ? 'true' : 'false'
  } else {
    text = String(value)
  }
  text = text.replace(/\s+/g, ' ').trim()
  return text.length > 180
    ? `${text.slice(0, 177)}…`
    : text
}

export async function prepareAudiobookshelfAction(
  name,
  args = {},
  context = {}
) {
  if (!AUDIOBOOKSHELF_WRITE_TOOL_NAMES.has(name)) {
    throw toolError(`Kein Audiobookshelf-Schreibtool: ${name}`)
  }

  const updates = normalizeAudiobookshelfUpdates({
    updates: args.updates
  })
  const before = []

  for (const update of updates) {
    const item = await localRequest(
      `/items/${encodeURIComponent(update.id)}`,
      context
    )
    if (item?.mediaType !== 'book') {
      throw toolError(
        `Item ${update.id} ist kein Buch`,
        'AUDIOBOOKSHELF_NOT_A_BOOK',
        409
      )
    }
    if (item?.updatedAt !== update.expectedUpdatedAt) {
      throw toolError(
        `Item ${update.id} wurde seit der Vorschau geaendert`,
        'AUDIOBOOKSHELF_STALE_PREVIEW',
        409
      )
    }
    before.push(item)
  }

  return {
    name,
    args: { updates },
    before
  }
}

export function formatAudiobookshelfPreview(action) {
  const lines = [
    `Audiobookshelf: ${action.args.updates.length} Metadaten-Aenderung${
      action.args.updates.length === 1 ? '' : 'en'
    }`
  ]

  action.args.updates.forEach((update, index) => {
    const item = action.before[index]
    const label =
      item?.metadata?.title ||
      item?.relPath ||
      update.id
    lines.push('', `${index + 1}. ${shortValue(label)}`)
    for (const [field, next] of Object.entries(update.metadata)) {
      const previous = metadataBeforeValue(item, field)
      if (sameValue(previous, next)) continue
      lines.push(
        `   ${field}: ${shortValue(previous)} -> ${shortValue(next)}`
      )
    }
  })

  return lines.join('\n')
}
