const MAX_CHECKPOINTS = 24
const MAX_RESULT_LENGTH = 12_000

function compact(value, maxLength) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}

function checkpointKey(name, args) {
  if (name === 'web_search') {
    return `web_search:${compact(args?.query, 600).toLowerCase()}`
  }

  if (name === 'firecrawl_scrape') {
    try {
      const url = new URL(String(args?.url || '').trim())
      url.hash = ''
      return `firecrawl_scrape:${url.href}`
    } catch {
      return `firecrawl_scrape:${compact(args?.url, 2_000)}`
    }
  }

  return ''
}

function normalizeCheckpoint(value) {
  if (!value || typeof value !== 'object') return null

  const name = value.name
  if (name === 'web_search') {
    const query = compact(value.args?.query, 600)
    const result = String(value.result || '').slice(0, MAX_RESULT_LENGTH)
    if (!query || !result) return null
    return {
      name,
      args: { query },
      result,
      key: checkpointKey(name, { query })
    }
  }

  if (name === 'firecrawl_scrape') {
    const url = compact(value.args?.url, 2_000)
    const result = String(value.result || '').slice(0, MAX_RESULT_LENGTH)
    if (!url || !result) return null
    return {
      name,
      args: { url },
      result,
      key: checkpointKey(name, { url })
    }
  }

  return null
}

export function normalizeChatCheckpoints(values) {
  if (!Array.isArray(values)) return []

  const seen = new Set()
  const checkpoints = []

  for (const value of values) {
    const checkpoint = normalizeCheckpoint(value)
    if (!checkpoint || seen.has(checkpoint.key)) continue
    seen.add(checkpoint.key)
    checkpoints.push(checkpoint)
    if (checkpoints.length >= MAX_CHECKPOINTS) break
  }

  return checkpoints
}

export function chatCheckpointForTool(name, args, result) {
  return normalizeCheckpoint({ name, args, result })
}

export function chatCheckpointKey(name, args) {
  return checkpointKey(name, args)
}

export function formatChatCheckpointContext(checkpoints) {
  if (!checkpoints.length) return ''

  return '\n\n[Session-only continuation checkpoints. These completed research results are available already. Use them and continue with the next open step; do not repeat this research unless a genuinely different query or URL is required.\n\n' +
    checkpoints.map((checkpoint, index) => {
      const label = checkpoint.name === 'web_search'
        ? `web_search: ${checkpoint.args.query}`
        : `firecrawl_scrape: ${checkpoint.args.url}`
      return `Checkpoint ${index + 1} (${label})\n${checkpoint.result}`
    }).join('\n\n') +
    '\n]'
}
