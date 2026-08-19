import {
  normalizeEmbedding
} from './memoryEmbeddingCore.js'

function linkedTimeoutSignal(signal, timeoutMs) {
  const controller = new AbortController()
  let timeout = null

  const abort = () => {
    controller.abort(
      signal?.reason ||
      new DOMException('Aborted', 'AbortError')
    )
  }

  if (signal?.aborted) {
    abort()
  } else if (signal) {
    signal.addEventListener('abort', abort, { once: true })
  }

  timeout = setTimeout(() => {
    controller.abort(
      new DOMException(
        `Embedding request timed out after ${timeoutMs} ms`,
        'TimeoutError'
      )
    )
  }, timeoutMs)

  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
    }
  }
}

export function createOllamaEmbeddingClient({
  baseUrl = 'http://127.0.0.1:11434',
  model = 'embeddinggemma',
  dimensions = 256,
  timeoutMs = 8000,
  keepAlive = '0s',
  fetchImpl = globalThis.fetch
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('Embedding client requires fetch')
  }

  const endpoint =
    `${String(baseUrl).replace(/\/+$/, '')}/api/embed`

  return {
    model,
    dimensions,

    async embed(inputs, { signal } = {}) {
      const values = Array.isArray(inputs)
        ? inputs
        : [inputs]

      if (
        values.length === 0 ||
        values.length > 64 ||
        values.some(value => !String(value || '').trim())
      ) {
        throw new Error('Embedding input batch is invalid')
      }

      const timeout = linkedTimeoutSignal(signal, timeoutMs)

      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model,
            input: values.map(value => String(value).slice(0, 12000)),
            truncate: true,
            dimensions,
            keep_alive: keepAlive
          }),
          signal: timeout.signal
        })

        if (!response.ok) {
          const body = await response.text()
          throw new Error(
            `Ollama embedding ${response.status}: ${body.slice(0, 300)}`
          )
        }

        const data = await response.json()

        if (
          !Array.isArray(data?.embeddings) ||
          data.embeddings.length !== values.length
        ) {
          throw new Error('Ollama returned an invalid embedding batch')
        }

        return data.embeddings.map(vector =>
          normalizeEmbedding(vector, dimensions)
        )
      } finally {
        timeout.cleanup()
      }
    }
  }
}

