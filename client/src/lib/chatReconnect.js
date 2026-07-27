export const MAX_CHAT_RECONNECT_RETRIES = 8

export function chatReconnectDelayMs(attempt) {
  const normalizedAttempt = Math.max(
    1,
    Number(attempt) || 1
  )

  return Math.min(
    1_000 * Math.pow(2, normalizedAttempt - 1),
    10_000
  )
}

export function chatReconnectingContent(
  content,
  attempt,
  maxRetries = MAX_CHAT_RECONNECT_RETRIES
) {
  return (
    String(content || '') +
    `\n\n_Reconnecting… (${attempt}/${maxRetries})_`
  )
}

export function clearChatReconnectContent(content) {
  return String(content || '').replace(
    /\n\n_Reconnecting… \(\d+\/\d+\)_$/,
    ''
  )
}

export function resolveChatActionRequests(
  actionRequests,
  actionId
) {
  if (!Array.isArray(actionRequests)) return []

  const resolvedId = String(actionId || '')
  return actionRequests.filter(
    request => String(request?.actionId || '') !== resolvedId
  )
}
