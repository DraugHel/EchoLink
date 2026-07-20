const activeChatRequests = new Map()

function requestKey(userId, requestId) {
  return `${Number(userId)}:${String(requestId)}`
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
  controller
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

  const entry = {
    key,
    userId: Number(userId),
    conversationId: Number(conversationId),
    requestId,
    controller,
    cancelled: false,
    createdAt: Date.now()
  }

  activeChatRequests.set(key, entry)
  return entry
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
}

export function activeChatRequestCount() {
  return activeChatRequests.size
}
