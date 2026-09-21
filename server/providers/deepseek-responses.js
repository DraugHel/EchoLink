import { DEEPSEEK_KEY } from './openai-compatible.js'
import {
  isRetryableResponsesStatus,
  normalizeResponsesToolArguments,
  normalizeResponsesUsage
} from './openai-responses.js'
import { ALL_TOOLS } from '../lib/toolRegistry.js'
import { imgMediaType } from '../lib/images.js'

const DEEPSEEK_RESPONSES_URL = 'https://api.deepseek.com/responses'

export function normalizeDeepSeekResponsesModel(model) {
  const value = String(model || '').trim()
  if (value === 'deepseek-v4-flash') return 'deepseek-flash'
  return value
}

export function deepSeekReasoningEffort(value) {
  const effort = String(value || '').trim().toLowerCase()
  if (!effort) return null
  if (effort === 'off' || effort === 'none') return 'none'
  if (effort === 'minimal' || effort === 'low') return 'low'
  if (
    effort === 'medium' ||
    effort === 'high' ||
    effort === 'xhigh'
  ) {
    return 'high'
  }
  if (effort === 'max' || effort === 'ultra') return 'max'
  return null
}

export function toDeepSeekResponsesTools(tools = []) {
  return tools.map(tool => {
    const fn = tool?.function || {}
    return {
      type: 'function',
      name: fn.name,
      description: fn.description,
      parameters: fn.parameters
    }
  })
}

function cloneRawItem(item) {
  return JSON.parse(JSON.stringify(item))
}

export function toDeepSeekResponsesInput(messages = []) {
  let instructions = ''
  let hasPrimarySystem = false
  let pendingCallIds = []
  const input = []

  for (const message of messages) {
    const role = message?.role

    if (role === 'system') {
      if (!hasPrimarySystem) {
        instructions = String(message.content || '')
        hasPrimarySystem = true
      } else {
        input.push({
          role: 'system',
          content: [{
            type: 'input_text',
            text: String(message.content || '')
          }]
        })
      }
      continue
    }

    if (role === 'assistant' && Array.isArray(message._raw)) {
      const raw = message._raw.map(cloneRawItem)
      pendingCallIds = raw
        .filter(item => item?.type === 'function_call')
        .map(item => item.call_id)
        .filter(Boolean)
      input.push(...raw)
      continue
    }

    if (role === 'assistant' && message.tool_calls?.length) {
      if (message.content) {
        input.push({
          role: 'assistant',
          content: [{
            type: 'output_text',
            text: String(message.content)
          }]
        })
      }
      pendingCallIds = []
      message.tool_calls.forEach((toolCall, index) => {
        const callId =
          toolCall?.id || `call_gen_${input.length}_${index}`
        pendingCallIds.push(callId)
        input.push({
          type: 'function_call',
          call_id: callId,
          name: toolCall?.function?.name,
          arguments: JSON.stringify(
            toolCall?.function?.arguments || {}
          )
        })
      })
      continue
    }

    if (role === 'tool') {
      let callId = message.tool_call_id
      if (callId) {
        const index = pendingCallIds.indexOf(callId)
        if (index !== -1) pendingCallIds.splice(index, 1)
      } else {
        callId =
          pendingCallIds.shift() ||
          `call_gen_${input.length}`
      }
      input.push({
        type: 'function_call_output',
        call_id: callId,
        output: String(message.content ?? '')
      })
      continue
    }

    if (role === 'assistant') {
      input.push({
        role: 'assistant',
        content: [{
          type: 'output_text',
          text: String(message.content || '')
        }]
      })
      continue
    }

    const text = String(message?.content || '')
    const canCarryImages =
      role === 'user' || role === 'developer'
    const images =
      canCarryImages && Array.isArray(message?.images)
        ? message.images
        : []

    if (images.length > 0) {
      const parts = images.map(base64 => ({
        type: 'input_image',
        image_url:
          `data:${imgMediaType(base64)};base64,${base64}`
      }))
      if (text) {
        parts.push({
          type: 'input_text',
          text
        })
      }
      input.push({
        role: role === 'developer' ? 'developer' : 'user',
        content: parts
      })
      continue
    }

    input.push({
      role:
        role === 'developer'
          ? 'developer'
          : role === 'system'
            ? 'system'
            : 'user',
      content: [{
        type: 'input_text',
        text
      }]
    })
  }

  return { instructions, input }
}

function annotateDeepSeekResponsesError(
  error,
  {
    retryable = false,
    partialOutput = false
  } = {}
) {
  const resolved = error instanceof Error
    ? error
    : new Error(
        String(error || 'DeepSeek Responses stream error')
      )
  resolved.retryable = retryable === true
  resolved.partialOutput = partialOutput === true
  return resolved
}

function processSseLines(buffer, onEvent) {
  const lines = buffer.split('\n')
  const remainder = lines.pop() || ''
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '')
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      onEvent(JSON.parse(payload))
    } catch {}
  }
  return remainder
}

export async function streamDeepSeekResponsesCore(
  model,
  messages,
  options,
  res,
  abortSignal,
  {
    key = DEEPSEEK_KEY,
    endpoint = DEEPSEEK_RESPONSES_URL,
    fetchImpl = globalThis.fetch
  } = {}
) {
  if (!key) {
    throw new Error(
      'API-Key fuer DeepSeek fehlt in der .env'
    )
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch implementation missing')
  }

  const providerModel =
    normalizeDeepSeekResponsesModel(model)
  const { instructions, input } =
    toDeepSeekResponsesInput(messages)
  const tools = toDeepSeekResponsesTools(
    options?.tools ?? ALL_TOOLS
  )
  const reasoningEffort =
    deepSeekReasoningEffort(options?.reasoningEffort)

  const body = {
    model: providerModel,
    stream: true,
    input,
    ...(instructions ? { instructions } : {}),
    ...(tools.length ? { tools } : {}),
    ...(options?.maxTokens != null
      ? { max_output_tokens: options.maxTokens }
      : {}),
    ...(reasoningEffort
      ? { reasoning: { effort: reasoningEffort } }
      : {})
  }

  let response
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`
      },
      body: JSON.stringify(body),
      signal: abortSignal
    })
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    throw annotateDeepSeekResponsesError(error, {
      retryable: true,
      partialOutput: false
    })
  }

  if (!response.ok) {
    const errorBody = await response.text()
    throw annotateDeepSeekResponsesError(
      new Error(
        `DeepSeek Responses ${response.status}: ` +
        errorBody.slice(0, 300)
      ),
      {
        retryable:
          isRetryableResponsesStatus(response.status),
        partialOutput: false
      }
    )
  }

  let fullContent = ''
  let fullThinking = ''
  let rawOutput = null
  let usage = null
  let streamCompleted = false
  let incompleteReason = ''
  let buffer = ''
  const decoder = new TextDecoder()

  const onEvent = event => {
    const eventType = event?.type || event?.event || ''

    if (
      eventType === 'response.output_text.delta' &&
      event.delta
    ) {
      fullContent += event.delta
      res.write(
        `data: ${JSON.stringify({
          token: event.delta
        })}\n\n`
      )
      return
    }

    if (
      eventType === 'response.reasoning_text.delta' &&
      event.delta
    ) {
      fullThinking += event.delta
      res.write(
        `data: ${JSON.stringify({
          think: event.delta
        })}\n\n`
      )
      return
    }

    if (eventType === 'response.completed') {
      streamCompleted = true
      rawOutput = event.response?.output || null
      usage = event.response?.usage || null
      return
    }

    if (eventType === 'response.incomplete') {
      rawOutput = event.response?.output || null
      usage = event.response?.usage || null
      incompleteReason =
        event.response?.incomplete_details?.reason ||
        'unknown'
      return
    }

    if (
      eventType === 'response.failed' ||
      eventType === 'error'
    ) {
      const providerError =
        event.response?.error || event.error || {}
      const message =
        providerError.message ||
        event.message ||
        'DeepSeek Responses stream error'
      const code = String(
        providerError.code ||
        providerError.type ||
        ''
      )
      throw annotateDeepSeekResponsesError(
        new Error(message),
        {
          retryable:
            message ===
              'DeepSeek Responses stream error' ||
            code === 'server_error' ||
            code === 'rate_limit_exceeded',
          partialOutput: Boolean(
            fullContent || fullThinking
          )
        }
      )
    }
  }

  try {
    for await (const chunk of response.body) {
      buffer += decoder.decode(
        chunk,
        { stream: true }
      )
      buffer = processSseLines(buffer, onEvent)
    }

    buffer += decoder.decode()
    if (buffer.trim()) {
      processSseLines(`${buffer}\n`, onEvent)
    }
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    if (
      error?.retryable === true ||
      error?.retryable === false
    ) {
      error.partialOutput = Boolean(
        error.partialOutput ||
        fullContent ||
        fullThinking
      )
      throw error
    }
    throw annotateDeepSeekResponsesError(error, {
      retryable: true,
      partialOutput: Boolean(
        fullContent || fullThinking
      )
    })
  }

  if (!streamCompleted) {
    const message = incompleteReason
      ? `DeepSeek Responses incomplete: ${incompleteReason}`
      : 'DeepSeek Responses stream ended without a terminal event'
    throw annotateDeepSeekResponsesError(
      new Error(message),
      {
        retryable: !incompleteReason,
        partialOutput: Boolean(
          fullContent || fullThinking
        )
      }
    )
  }

  const toolCalls = (rawOutput || [])
    .filter(item => item?.type === 'function_call')
    .map(item => {
      let args = {}
      try {
        args = item.arguments
          ? JSON.parse(item.arguments)
          : {}
      } catch {}

      return {
        id: item.call_id,
        function: {
          name: item.name,
          arguments:
            normalizeResponsesToolArguments(
              item.name,
              args
            )
        }
      }
    })

  return {
    fullContent,
    fullThinking,
    toolCalls,
    tokenUsage: normalizeResponsesUsage(usage),
    rawOutput,
    completed: streamCompleted
  }
}

export function streamDeepSeekResponses(
  model,
  messages,
  options,
  res,
  abortSignal
) {
  return streamDeepSeekResponsesCore(
    model,
    messages,
    options,
    res,
    abortSignal
  )
}
