const MAX_EVIDENCE_ITEMS = 30
const MAX_CONTENT_LENGTH = 20_000
const MAX_LABEL_LENGTH = 160

function boundedText(value, maxLength) {
  return String(value || '')
    .trim()
    .slice(0, maxLength)
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null
  }

  const number = Number(value)
  return Number.isFinite(number)
    ? number
    : null
}

function positiveInteger(value) {
  const number = Number.parseInt(value, 10)
  return Number.isInteger(number) && number > 0
    ? number
    : null
}

export function createMemoryEvidence(items) {
  if (!Array.isArray(items)) return []

  return items
    .slice(0, MAX_EVIDENCE_ITEMS)
    .map(item => ({
      id: positiveInteger(item?.id),
      type: boundedText(
        item?.type,
        MAX_LABEL_LENGTH
      ),
      scope: boundedText(
        item?.scope,
        MAX_LABEL_LENGTH
      ),
      content: boundedText(
        item?.content,
        MAX_CONTENT_LENGTH
      ),
      importance:
        finiteNumber(item?.importance),
      confidence:
        finiteNumber(item?.confidence),
      retrievalMode: boundedText(
        item?.retrievalMode,
        MAX_LABEL_LENGTH
      ),
      retrievalScore:
        finiteNumber(item?.retrievalScore),
      lexicalScore:
        finiteNumber(item?.lexicalScore),
      semanticSimilarity:
        finiteNumber(item?.semanticSimilarity)
    }))
    .filter(item => item.id && item.content)
}

export function serializeMemoryEvidence(items) {
  return JSON.stringify(
    createMemoryEvidence(items)
  )
}

export function parseMemoryEvidence(value) {
  if (value === null || value === undefined || value === '') {
    return null
  }

  try {
    const parsed = typeof value === 'string'
      ? JSON.parse(value)
      : value

    if (!Array.isArray(parsed)) return null
    return createMemoryEvidence(parsed)
  } catch {
    return null
  }
}
