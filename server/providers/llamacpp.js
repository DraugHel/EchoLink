function normalizedBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '')
}

function enabledFlag(value) {
  return /^(?:1|true|yes|on)$/i.test(String(value || '').trim())
}

function imageMediaType(base64) {
  if (base64.startsWith('/9j/')) return 'image/jpeg'
  if (base64.startsWith('iVBOR')) return 'image/png'
  if (base64.startsWith('R0lGOD')) return 'image/gif'
  if (base64.startsWith('UklGR')) return 'image/webp'
  return 'image/jpeg'
}

function toChatCompletionsMessages(messages) {
  const converted = []
  let pendingToolCallIds = []

  for (const message of messages || []) {
    if (
      message.role === 'assistant' &&
      message.tool_calls?.length
    ) {
      pendingToolCallIds = []
      converted.push({
        role: 'assistant',
        content: message.content || null,
        tool_calls: message.tool_calls.map((toolCall, index) => {
          const id =
            toolCall.id ||
            `call_llamacpp_${converted.length}_${index}`
          pendingToolCallIds.push(id)

          return {
            id,
            type: 'function',
            function: {
              name: toolCall.function.name,
              arguments: JSON.stringify(
                toolCall.function.arguments || {}
              )
            }
          }
        })
      })
      continue
    }

    if (message.role === 'tool') {
      converted.push({
        role: 'tool',
        tool_call_id:
          pendingToolCallIds.shift() ||
          `call_llamacpp_${converted.length}`,
        content: String(message.content ?? '')
      })
      continue
    }

    if (message.images?.length) {
      const content = message.images.map(base64 => ({
        type: 'image_url',
        image_url: {
          url:
            `data:${imageMediaType(base64)};base64,${base64}`
        }
      }))

      if (message.content) {
        content.push({
          type: 'text',
          text: message.content
        })
      }

      converted.push({
        role: message.role,
        content
      })
      continue
    }

    converted.push({
      role: message.role,
      content: message.content || ''
    })
  }

  return converted
}

function requestHeaders() {
  if (!LLAMACPP_API_KEY) {
    throw new Error(
      'LLAMACPP_API_KEY fehlt in der .env'
    )
  }

  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${LLAMACPP_API_KEY}`
  }
}

function endpoint(pathname) {
  if (!LLAMACPP_URL) {
    throw new Error(
      'LLAMACPP_URL fehlt in der .env'
    )
  }

  return `${LLAMACPP_URL}/${pathname.replace(/^\/+/, '')}`
}

function normalizedUsage(usage) {
  if (!usage) return null

  const promptTokens = usage.prompt_tokens || 0
  const completionTokens = usage.completion_tokens || 0

  return {
    promptTokens,
    completionTokens,
    totalTokens:
      usage.total_tokens ||
      promptTokens + completionTokens,
    cachedTokens:
      usage.prompt_tokens_details?.cached_tokens || 0,
    cacheWriteTokens: 0,
    cacheObserved:
      usage.prompt_tokens_details?.cached_tokens !== undefined
  }
}

export const LLAMACPP_URL = normalizedBaseUrl(
  process.env.LLAMACPP_URL
)

export const LLAMACPP_API_KEY =
  process.env.LLAMACPP_API_KEY || ''

export const LLAMACPP_TOOLS_ENABLED = enabledFlag(
  process.env.LLAMACPP_TOOLS_ENABLED
)

export function llamaCppConfigured() {
  return Boolean(LLAMACPP_URL && LLAMACPP_API_KEY)
}

export async function streamLlamaCpp(
  model,
  messages,
  options,
  res,
  abortSignal
) {
  let tools = options?.tools

  if (
    LLAMACPP_TOOLS_ENABLED &&
    tools === undefined
  ) {
    const registry = await import('../lib/toolRegistry.js')
    tools = registry.ALL_TOOLS
  }

  const body = {
    model,
    stream: true,
    stream_options: {
      include_usage: true
    },
    messages: toChatCompletionsMessages(messages),
    ...(options?.temperature != null
      ? {
          temperature: Math.min(
            Math.max(options.temperature, 0),
            2
          )
        }
      : {}),
    ...(options?.top_p != null
      ? { top_p: options.top_p }
      : {}),
    ...(
      LLAMACPP_TOOLS_ENABLED &&
      Array.isArray(tools) &&
      tools.length
      ? { tools }
      : {}
    )
  }

  const response = await fetch(
    endpoint('chat/completions'),
    {
      method: 'POST',
      headers: requestHeaders(),
      body: JSON.stringify(body),
      signal: abortSignal
    }
  )

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(
      `llama.cpp ${response.status}: ` +
      errorBody.slice(0, 300)
    )
  }

  let fullContent = ''
  let fullThinking = ''
  let usage = null
  let buffer = ''
  const toolAccumulator = {}
  const decoder = new TextDecoder()

  function consumeLine(line) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) return

    const payload = trimmed.slice(5).trim()
    if (!payload || payload === '[DONE]') return

    let event
    try {
      event = JSON.parse(payload)
    } catch {
      return
    }

    if (event.error) {
      throw new Error(
        event.error.message ||
        'llama.cpp stream error'
      )
    }

    if (event.usage || event.choices?.[0]?.usage) {
      usage = event.usage || event.choices[0].usage
    }

    const delta = event.choices?.[0]?.delta
    if (!delta) return

    if (delta.reasoning_content) {
      fullThinking += delta.reasoning_content
      res.write(
        `data: ${JSON.stringify({
          think: delta.reasoning_content
        })}\n\n`
      )
    }

    if (delta.content) {
      fullContent += delta.content
      res.write(
        `data: ${JSON.stringify({
          token: delta.content
        })}\n\n`
      )
    }

    for (const toolCall of delta.tool_calls || []) {
      const index = toolCall.index ?? 0

      if (!toolAccumulator[index]) {
        toolAccumulator[index] = {
          id: toolCall.id || null,
          name: '',
          arguments: ''
        }
      }

      if (toolCall.id) {
        toolAccumulator[index].id = toolCall.id
      }
      if (toolCall.function?.name) {
        toolAccumulator[index].name +=
          toolCall.function.name
      }
      if (toolCall.function?.arguments) {
        toolAccumulator[index].arguments +=
          toolCall.function.arguments
      }
    }
  }

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      consumeLine(line)
    }
  }

  buffer += decoder.decode()
  if (buffer.trim()) consumeLine(buffer)

  const toolCalls = Object.values(toolAccumulator)
    .filter(toolCall => toolCall.name)
    .map(toolCall => {
      let argumentsValue = {}

      try {
        argumentsValue = toolCall.arguments
          ? JSON.parse(toolCall.arguments)
          : {}
      } catch {}

      return {
        id: toolCall.id,
        function: {
          name: toolCall.name,
          arguments: argumentsValue
        }
      }
    })

  return {
    fullContent,
    fullThinking,
    toolCalls,
    tokenUsage: normalizedUsage(usage)
  }
}

export async function completeLlamaCpp(
  model,
  messages,
  options = {},
  abortSignal
) {
  const response = await fetch(
    endpoint('chat/completions'),
    {
      method: 'POST',
      headers: requestHeaders(),
      body: JSON.stringify({
        model,
        stream: false,
        messages: toChatCompletionsMessages(messages),
        ...(options.temperature != null
          ? { temperature: options.temperature }
          : {}),
        ...(options.top_p != null
          ? { top_p: options.top_p }
          : {}),
        ...(options.maxTokens != null
          ? { max_tokens: options.maxTokens }
          : {})
      }),
      signal: abortSignal
    }
  )

  const raw = await response.text()
  let data

  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error(
      'llama.cpp lieferte keine gültige JSON-Antwort'
    )
  }

  if (!response.ok || data?.error) {
    throw new Error(
      `llama.cpp ${response.status}: ` +
      String(
        data?.error?.message ||
        data?.error ||
        raw
      ).slice(0, 300)
    )
  }

  const message = data?.choices?.[0]?.message

  return String(
    message?.content ||
    message?.reasoning_content ||
    ''
  ).trim()
}
