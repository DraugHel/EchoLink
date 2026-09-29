// Zentrale Zuordnung Modellname -> Provider.
// Chat, geplante Agenten, Memory und Zusammenfassungen nutzen dieselbe Stelle.
import { streamOllama } from './ollama.js'
import {
  llamaCppConfigured,
  streamLlamaCpp
} from './llamacpp.js'
import {
  DEEPSEEK_KEY,
  KIMI_KEY,
  OPENAI_KEY,
  ZAI_KEY,
  splitSystemTimeNote,
  streamKimi,
  streamZai
} from './openai-compatible.js'
import { ANTHROPIC_KEY, streamAnthropic } from './anthropic.js'
import { streamResponses } from './openai-responses.js'
import { streamDeepSeekResponses } from './deepseek-responses.js'
import { incompleteStreamError } from './streamErrors.js'

export { incompleteStreamError }

const PREFIXED_PROVIDERS = [
  {
    prefix: 'zai/',
    name: 'zai',
    label: 'Z.ai',
    streamFn: streamZai,
    configured: () => Boolean(ZAI_KEY)
  },
  {
    prefix: 'kimi/',
    name: 'kimi',
    label: 'Kimi',
    streamFn: streamKimi,
    configured: () => Boolean(KIMI_KEY)
  },
  {
    prefix: 'deepseek/',
    name: 'deepseek',
    label: 'DeepSeek',
    streamFn: streamDeepSeekResponses,
    configured: () => Boolean(DEEPSEEK_KEY)
  },
  {
    prefix: 'openai/',
    name: 'openai',
    label: 'OpenAI',
    streamFn: streamResponses,
    configured: () => Boolean(OPENAI_KEY)
  },
  {
    prefix: 'llamacpp/',
    name: 'llamacpp',
    label: 'llama.cpp',
    streamFn: streamLlamaCpp,
    configured: llamaCppConfigured
  }
]

export function resolveProvider(model) {
  const value = String(model || '').trim()

  if (value.startsWith('claude')) {
    return Object.freeze({
      name: 'anthropic',
      label: 'Anthropic',
      providerModel: value,
      streamFn: streamAnthropic,
      configured: Boolean(ANTHROPIC_KEY),
      splitTimeNote: false
    })
  }

  for (const provider of PREFIXED_PROVIDERS) {
    if (!value.startsWith(provider.prefix)) continue
    return Object.freeze({
      name: provider.name,
      label: provider.label,
      providerModel: value.slice(provider.prefix.length),
      streamFn: provider.streamFn,
      configured: provider.configured(),
      splitTimeNote: true
    })
  }

  // Unpräfixierte Modelle (z.B. glm-5.1:cloud) laufen über Ollama.
  return Object.freeze({
    name: 'ollama',
    label: 'Ollama',
    providerModel: value,
    streamFn: streamOllama,
    configured: true,
    splitTimeNote: false
  })
}

// OpenAI-kompatible Provider cachen den stabilen System-Prompt nur, wenn der
// sich minütlich ändernde Zeithinweis in eine eigene Nachricht wandert.
export function prepareProviderMessages(provider, messages) {
  return provider.splitTimeNote
    ? splitSystemTimeNote(messages)
    : messages
}

const SILENT_SINK = Object.freeze({
  writableEnded: false,
  write() {
    return true
  }
})

// Einmalige Anfrage ohne Tools und ohne Ausgabe an einen Client.
export async function completeWithProvider({
  model,
  messages,
  options = {},
  signal
}) {
  const provider = resolveProvider(model)
  if (!provider.configured) {
    throw new Error(`${provider.label} ist nicht konfiguriert`)
  }

  const result = await provider.streamFn(
    provider.providerModel,
    prepareProviderMessages(
      provider,
      (messages || []).map(message => ({ ...message }))
    ),
    { tools: [], ...options },
    SILENT_SINK,
    signal
  )

  if (result?.completed === false) {
    throw incompleteStreamError(provider.label, result)
  }

  return {
    ...result,
    provider: provider.name,
    providerModel: provider.providerModel
  }
}
