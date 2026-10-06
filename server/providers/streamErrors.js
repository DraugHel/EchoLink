// Gemeinsame Fehlerbehandlung für alle Stream-Provider.
// chat.js wiederholt einen Aufruf nur, wenn retryable === true ist und
// noch keine Teilausgabe an den Client ging (partialOutput !== true).

export function isRetryableStatus(status) {
  const value = Number(status)
  return value === 408 || value === 429 || value >= 500
}

export function markProviderError(
  error,
  { retryable = false, partialOutput = false } = {}
) {
  const resolved = error instanceof Error
    ? error
    : new Error(String(error || 'Provider-Fehler'))
  resolved.retryable = retryable === true
  resolved.partialOutput = partialOutput === true
  return resolved
}

// Fehler während des Stream-Lesens: Abbrüche durch den Nutzer bleiben
// unverändert, bereits markierte Fehler behalten ihre Einstufung, alles
// andere (z.B. Verbindungsabbruch) gilt als vorübergehend.
export function streamFailure(error, partialOutput) {
  if (error?.name === 'AbortError') return error
  if (typeof error?.retryable === 'boolean') {
    error.partialOutput = Boolean(
      error.partialOutput || partialOutput
    )
    return error
  }
  return markProviderError(error, {
    retryable: true,
    partialOutput: Boolean(partialOutput)
  })
}

const MAX_ERROR_TEXT = 300

// Provider-Fehler kommen meist als JSON ({"error":{"message":"..."}}).
// Im Chat soll nur die eigentliche Meldung stehen, nicht das ganze JSON.
export function providerErrorText(body) {
  const text = String(body ?? '').trim()

  if (!text) return ''

  try {
    const data = JSON.parse(text)
    const message =
      typeof data?.error === 'string'
        ? data.error
        : data?.error?.message ?? data?.message ?? data?.detail

    if (typeof message === 'string' && message.trim()) {
      return message
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, MAX_ERROR_TEXT)
    }
  } catch {
    // Kein JSON: Rohtext gekuerzt ausgeben.
  }

  return text.slice(0, 200)
}

export async function fetchProviderStream(url, init, label) {
  let response
  try {
    response = await fetch(url, init)
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    throw markProviderError(error, { retryable: true })
  }

  if (!response.ok) {
    let body = ''
    try {
      body = await response.text()
    } catch {}
    throw markProviderError(
      new Error(`${label} ${response.status}: ${providerErrorText(body)}`),
      { retryable: isRetryableStatus(response.status) }
    )
  }

  return response
}

export function incompleteStreamError(label, result) {
  return markProviderError(
    new Error(`${label}: Antwort-Stream endete ohne Abschluss`),
    {
      retryable: true,
      partialOutput: Boolean(
        result?.fullContent || result?.fullThinking
      )
    }
  )
}
