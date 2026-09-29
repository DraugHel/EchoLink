import {
  prepareProviderMessages,
  resolveProvider
} from '../providers/index.js'

const CONFIG_LABELS = {
  anthropic: 'Anthropic',
  llamacpp: 'llama.cpp'
}

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

  const provider = resolveProvider(requestedModel)
  if (!provider.configured) {
    throwConfigured(CONFIG_LABELS[provider.name] || provider.name)
  }

  return {
    provider: provider.name,
    providerModel: provider.providerModel,
    streamFn: provider.streamFn,
    transformMessages: messages =>
      prepareProviderMessages(provider, messages)
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
