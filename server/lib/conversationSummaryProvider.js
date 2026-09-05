import { streamOllama } from '../providers/ollama.js'
import {
  llamaCppConfigured,
  streamLlamaCpp
} from '../providers/llamacpp.js'
import {
  OPENAI_KEY,
  ZAI_KEY,
  KIMI_KEY,
  DEEPSEEK_KEY,
  streamZai,
  streamKimi,
  streamDeepSeek,
  splitSystemTimeNote
} from '../providers/openai-compatible.js'
import {
  ANTHROPIC_KEY,
  streamAnthropic
} from '../providers/anthropic.js'
import { streamResponses } from '../providers/openai-responses.js'

function collectorResponse() {
  return {
    writableEnded: false,
    write() {
      return true
    }
  }
}

export function resolveConversationSummaryProvider(model) {
  const requestedModel = String(model || '').trim()
  if (!requestedModel || requestedModel.length > 200 || /[\r\n\0]/.test(requestedModel)) {
    const error = new Error('Ungültiges Zusammenfassungsmodell.')
    error.code = 'SUMMARY_MODEL_INVALID'
    error.status = 400
    throw error
  }

  if (requestedModel.startsWith('claude')) {
    if (!ANTHROPIC_KEY) throwConfigured('Anthropic')
    return {
      provider: 'anthropic',
      providerModel: requestedModel,
      streamFn: streamAnthropic,
      transformMessages: messages => messages
    }
  }

  const mappings = [
    ['zai/', 'zai', ZAI_KEY, streamZai],
    ['kimi/', 'kimi', KIMI_KEY, streamKimi],
    ['deepseek/', 'deepseek', DEEPSEEK_KEY, streamDeepSeek],
    ['openai/', 'openai', OPENAI_KEY, streamResponses]
  ]

  for (const [prefix, provider, key, streamFn] of mappings) {
    if (!requestedModel.startsWith(prefix)) continue
    if (!key) throwConfigured(provider)
    return {
      provider,
      providerModel: requestedModel.slice(prefix.length),
      streamFn,
      transformMessages: splitSystemTimeNote
    }
  }

  if (requestedModel.startsWith('llamacpp/')) {
    if (!llamaCppConfigured()) throwConfigured('llama.cpp')
    return {
      provider: 'llamacpp',
      providerModel: requestedModel.slice(9),
      streamFn: streamLlamaCpp,
      transformMessages: splitSystemTimeNote
    }
  }

  // Unprefixed models are the existing Ollama path, matching chat.js.
  return {
    provider: 'ollama',
    providerModel: requestedModel,
    streamFn: streamOllama,
    transformMessages: messages => messages
  }
}

function throwConfigured(provider) {
  const error = new Error(`${provider} ist auf diesem EchoLink-Server nicht konfiguriert.`)
  error.code = 'SUMMARY_PROVIDER_NOT_CONFIGURED'
  error.status = 400
  throw error
}

export function isConversationSummaryModelConfigured(model) {
  try {
    resolveConversationSummaryProvider(model)
    return true
  } catch {
    return false
  }
}

export async function runConversationSummaryProvider({
  model,
  messages,
  maxTokens,
  signal
}) {
  const resolved = resolveConversationSummaryProvider(model)
  const preparedMessages = resolved.transformMessages(
    (messages || []).map(message => ({ ...message }))
  )

  const result = await resolved.streamFn(
    resolved.providerModel,
    preparedMessages,
    {
      tools: [],
      maxTokens,
      summaryMode: true
    },
    collectorResponse(),
    signal
  )

  return {
    ...result,
    provider: resolved.provider,
    requestedModel: model,
    providerModel: resolved.providerModel
  }
}
