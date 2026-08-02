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

const RETRYABLE_STREAM_APPLICATION_ERRORS = new Set([
  'OpenAI Responses stream error'
])

export function chatStreamApplicationError(value) {
  const message =
    typeof value === 'string'
      ? value.trim()
      : String(value?.message || '').trim()
  const error = new Error(
    message || 'Chat stream failed'
  )

  // A bare OpenAI response.failed event has no actionable application error
  // and is commonly a transient upstream stream failure. Reuse the existing
  // bounded reconnect path with the same request ID instead of marking the
  // whole agent run as failed immediately. Specific provider/application
  // errors remain non-retryable unless the server explicitly opts in.
  error.retryable = Boolean(
    value?.retryable === true ||
    RETRYABLE_STREAM_APPLICATION_ERRORS.has(message)
  )
  return error
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

export function attachPendingChatActions(
  messages,
  actionRequests
) {
  const base = Array.isArray(messages)
    ? messages.map(message => ({
        ...message,
        actionRequests: []
      }))
    : []

  const actions = []
  const seen = new Set()

  for (const action of Array.isArray(actionRequests)
    ? actionRequests
    : []) {
    const actionId = String(action?.actionId || '')
    if (!actionId || seen.has(actionId)) continue
    seen.add(actionId)
    actions.push({
      ...action,
      actionId
    })
  }

  if (actions.length === 0) return base

  return [
    ...base,
    {
      id: `pending-action:${actions[0].actionId}`,
      role: 'assistant',
      content: '',
      streaming: false,
      pendingActionOnly: true,
      actionRequests: actions
    }
  ]
}
