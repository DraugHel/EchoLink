const activeChatRequests = new Map()
const completedChatRequests = new Map()

const COMPLETED_REQUEST_TTL_MS = 30 * 60 * 1000

function requestKey(userId, requestId) {
  return `${Number(userId)}:${String(requestId)}`
}

function pruneCompletedChatRequests(now = Date.now()) {
  for (const [key, entry] of completedChatRequests) {
    if (entry.expiresAt <= now) {
      completedChatRequests.delete(key)
    }
  }
}

export function isValidChatRequestId(value) {
  return (
    typeof value === 'string' &&
    value.length >= 8 &&
    value.length <= 120 &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  )
}

export function createChatAbortError(
  message = 'Chat request cancelled'
) {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

export function registerChatRequest({
  userId,
  conversationId,
  requestId,
  controller,
  payloadHash = ''
}) {
  if (!isValidChatRequestId(requestId)) {
    throw new TypeError('Invalid chat request ID')
  }

  const key = requestKey(userId, requestId)
  const previous = activeChatRequests.get(key)

  if (previous) {
    previous.cancelled = true
    previous.controller.abort()
  }

  let resolveCompletion
  const completion = new Promise(resolve => {
    resolveCompletion = resolve
  })

  const entry = {
    key,
    userId: Number(userId),
    conversationId: Number(conversationId),
    requestId,
    controller,
    payloadHash: String(payloadHash || ''),
    cancelled: false,
    createdAt: Date.now(),
    completedAt: null,
    completionStatus: null,
    responses: new Set(),
    completion,
    resolveCompletion
  }

  activeChatRequests.set(key, entry)
  return entry
}

export function findChatRequest({
  userId,
  conversationId,
  requestId
}) {
  if (!isValidChatRequestId(requestId)) {
    return null
  }

  pruneCompletedChatRequests()
  const key = requestKey(userId, requestId)
  const active = activeChatRequests.get(key)

  if (
    active &&
    active.conversationId === Number(conversationId)
  ) {
    return {
      state: 'running',
      payloadHash: active.payloadHash,
      entry: active
    }
  }

  const completed = completedChatRequests.get(key)
  if (
    completed &&
    completed.conversationId === Number(conversationId)
  ) {
    return {
      state: completed.status,
      payloadHash: completed.payloadHash,
      entry: null
    }
  }

  return null
}

export function attachChatResponse(entry, response) {
  if (!entry || !response || entry.completedAt) {
    return () => {}
  }

  entry.responses.add(response)
  return () => entry.responses.delete(response)
}

export function createChatResponseSink(entry) {
  if (!entry) {
    throw new TypeError('Chat request entry is required')
  }

  return {
    get writableEnded() {
      return Boolean(entry.completedAt)
    },
    write(chunk) {
      for (const response of [...entry.responses]) {
        if (response.writableEnded || response.destroyed) {
          entry.responses.delete(response)
          continue
        }

        try {
          response.write(chunk)
        } catch {
          entry.responses.delete(response)
        }
      }

      // Provider streams must keep consuming even with no mobile subscriber.
      return true
    }
  }
}

export function waitForChatRequest(entry) {
  return entry?.completion || Promise.resolve(null)
}

export function completeChatRequest(
  entry,
  status = 'completed'
) {
  if (!entry || entry.completedAt) return false

  pruneCompletedChatRequests()
  entry.completedAt = Date.now()
  entry.completionStatus = String(status || 'completed')

  if (activeChatRequests.get(entry.key) === entry) {
    activeChatRequests.delete(entry.key)
  }

  completedChatRequests.set(entry.key, {
    conversationId: entry.conversationId,
    payloadHash: entry.payloadHash,
    status: entry.completionStatus,
    expiresAt:
      entry.completedAt + COMPLETED_REQUEST_TTL_MS
  })

  for (const response of [...entry.responses]) {
    entry.responses.delete(response)
    if (response.writableEnded || response.destroyed) continue
    try {
      response.end()
    } catch {}
  }

  entry.resolveCompletion(entry.completionStatus)
  return true
}

export function abortChatRequest(entry) {
  if (!entry) return false

  entry.cancelled = true

  if (!entry.controller.signal.aborted) {
    entry.controller.abort()
  }

  return true
}

export function cancelChatRequest({
  userId,
  conversationId,
  requestId
}) {
  if (!isValidChatRequestId(requestId)) {
    return false
  }

  const entry = activeChatRequests.get(
    requestKey(userId, requestId)
  )

  if (
    !entry ||
    entry.conversationId !== Number(conversationId)
  ) {
    return false
  }

  return abortChatRequest(entry)
}

export function isChatRequestCancelled(entry) {
  return Boolean(
    entry?.cancelled ||
    entry?.controller?.signal?.aborted
  )
}

export function assertChatRequestActive(entry) {
  if (isChatRequestCancelled(entry)) {
    throw createChatAbortError()
  }
}

export function assertAbortSignalActive(signal) {
  if (signal?.aborted) {
    throw createChatAbortError()
  }
}

export function unregisterChatRequest(entry) {
  if (!entry) return

  if (activeChatRequests.get(entry.key) === entry) {
    activeChatRequests.delete(entry.key)
  }

  if (!entry.completedAt) {
    entry.completedAt = Date.now()
    entry.completionStatus = 'unregistered'
    entry.resolveCompletion(entry.completionStatus)
  }

  for (const response of [...(entry.responses || [])]) {
    entry.responses.delete(response)
  }
}

export function activeChatRequestCount() {
  return activeChatRequests.size
}
