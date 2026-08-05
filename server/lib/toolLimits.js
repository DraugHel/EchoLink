const MAX_TOOL_LIMIT = 2000
const MIN_AGENT_TIMEOUT_MS = 60_000
const MAX_AGENT_TIMEOUT_MS = 6 * 60 * 60 * 1000

export const DEFAULT_CHAT_TOOL_ITERATIONS = 500
export const DEFAULT_AGENT_TOOL_ITERATIONS = 500
export const DEFAULT_AGENT_TOOL_CALLS = 500
export const DEFAULT_AGENT_TIMEOUT_MS = 60 * 60 * 1000

function boundedInteger(
  value,
  fallback,
  minimum,
  maximum
) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(maximum, Math.max(minimum, parsed))
}

export function chatToolIterationLimit(
  env = process.env
) {
  return boundedInteger(
    env.CHAT_MAX_TOOL_ITERATIONS,
    DEFAULT_CHAT_TOOL_ITERATIONS,
    1,
    MAX_TOOL_LIMIT
  )
}

export function scheduledAgentToolIterationLimit(
  env = process.env
) {
  return boundedInteger(
    env.SCHEDULED_AGENT_MAX_TOOL_ITERATIONS,
    DEFAULT_AGENT_TOOL_ITERATIONS,
    1,
    MAX_TOOL_LIMIT
  )
}

export function scheduledAgentToolCallLimit(
  env = process.env
) {
  return boundedInteger(
    env.SCHEDULED_AGENT_MAX_TOOL_CALLS,
    DEFAULT_AGENT_TOOL_CALLS,
    1,
    MAX_TOOL_LIMIT
  )
}

export function scheduledAgentTimeoutMs(
  env = process.env
) {
  return boundedInteger(
    env.SCHEDULED_AGENT_TIMEOUT_MS,
    DEFAULT_AGENT_TIMEOUT_MS,
    MIN_AGENT_TIMEOUT_MS,
    MAX_AGENT_TIMEOUT_MS
  )
}
