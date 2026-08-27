// Token-based API cost estimation for EchoLink.
//
// Rates are pinned in code so a recorded event keeps an auditable pricing key.
// Unknown/future models are deliberately left unpriced instead of being
// silently treated as free.
//
// USD rates are per 1M tokens.

function finiteNonNegative(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0
    ? number
    : 0
}

function clamp(value, minimum, maximum) {
  return Math.min(
    maximum,
    Math.max(minimum, value)
  )
}

export function providerForModel(model) {
  const value = String(model || '').trim()
  const lower = value.toLowerCase()

  if (lower.startsWith('openai/')) return 'openai'
  if (lower.startsWith('zai/')) return 'zai'
  if (lower.startsWith('deepseek/')) return 'deepseek'
  if (lower.startsWith('kimi/')) return 'kimi'
  if (lower.startsWith('llamacpp/')) return 'llamacpp'
  if (lower.startsWith('claude')) return 'anthropic'

  if (/[:-]cloud$/i.test(value)) {
    return 'ollama-cloud'
  }

  return 'ollama'
}

function providerModelId(model) {
  const value = String(model || '').trim()
  const provider = providerForModel(value)

  const prefixes = {
    openai: 'openai/',
    zai: 'zai/',
    deepseek: 'deepseek/',
    kimi: 'kimi/',
    llamacpp: 'llamacpp/'
  }

  const prefix = prefixes[provider]

  return prefix && value.toLowerCase().startsWith(prefix)
    ? value.slice(prefix.length)
    : value
}

function pricing({
  key,
  input,
  cached,
  output,
  cacheWrite = input,
  source,
  local = false,
  cacheWriteSemantics = 'premium'
}) {
  return {
    key,
    inputPerMillion: input,
    cachedPerMillion: cached,
    cacheWritePerMillion: cacheWrite,
    outputPerMillion: output,
    source,
    local,
    cacheWriteSemantics
  }
}

function openAiPricing(id) {
  if (/^gpt-5\.6-luna(?:$|-)/i.test(id)) {
    return pricing({
      key: 'openai:gpt-5.6-luna:2026-07-30',
      input: 0.20,
      cached: 0.02,
      cacheWrite: 0.25,
      output: 1.20,
      source: 'OpenAI standard API pricing'
    })
  }

  if (/^gpt-5\.6-terra(?:$|-)/i.test(id)) {
    return pricing({
      key: 'openai:gpt-5.6-terra:2026-07-30',
      input: 2.00,
      cached: 0.20,
      cacheWrite: 2.50,
      output: 12.00,
      source: 'OpenAI standard API pricing'
    })
  }

  if (
    /^gpt-5\.6-sol(?:$|-)/i.test(id) ||
    /^gpt-5\.6$/i.test(id)
  ) {
    return pricing({
      key: 'openai:gpt-5.6-sol:2026-07-30',
      input: 4.00,
      cached: 0.40,
      cacheWrite: 5.00,
      output: 20.00,
      source: 'OpenAI standard API pricing'
    })
  }

  return null
}

function anthropicPricing(id) {
  if (/^claude-fable-5(?:$|-)/i.test(id)) {
    return pricing({
      key: 'anthropic:claude-fable-5',
      input: 10,
      cached: 1,
      cacheWrite: 12.5,
      output: 50,
      source: 'Anthropic Claude API pricing'
    })
  }

  if (
    /^claude-opus-5(?:$|-)/i.test(id) ||
    /^claude-opus-4-(?:8|7|6|5)(?:$|-)/i.test(id)
  ) {
    return pricing({
      key: 'anthropic:opus-5-or-4.5+',
      input: 5,
      cached: 0.5,
      cacheWrite: 6.25,
      output: 25,
      source: 'Anthropic Claude API pricing'
    })
  }

  if (/^claude-sonnet-5(?:$|-)/i.test(id)) {
    return pricing({
      key: 'anthropic:claude-sonnet-5',
      input: 2,
      cached: 0.2,
      cacheWrite: 2.5,
      output: 10,
      source: 'Anthropic Claude API pricing'
    })
  }

  if (
    /^claude-sonnet-4-(?:6|5)(?:$|-)/i.test(id) ||
    /^claude-sonnet-4(?:$|-)/i.test(id)
  ) {
    return pricing({
      key: 'anthropic:claude-sonnet-4.x',
      input: 3,
      cached: 0.3,
      cacheWrite: 3.75,
      output: 15,
      source: 'Anthropic Claude API pricing'
    })
  }

  if (/^claude-haiku-4-5(?:$|-)/i.test(id)) {
    return pricing({
      key: 'anthropic:claude-haiku-4.5',
      input: 1,
      cached: 0.1,
      cacheWrite: 1.25,
      output: 5,
      source: 'Anthropic Claude API pricing'
    })
  }

  if (
    /^claude-opus-4-1(?:$|-)/i.test(id) ||
    /^claude-opus-4(?:$|-)/i.test(id)
  ) {
    return pricing({
      key: 'anthropic:claude-opus-4-legacy',
      input: 15,
      cached: 1.5,
      cacheWrite: 18.75,
      output: 75,
      source: 'Anthropic Claude API pricing'
    })
  }

  return null
}

function deepSeekPricing(id) {
  if (/^deepseek-v4-flash(?:$|-)/i.test(id)) {
    return pricing({
      key: 'deepseek:v4-flash:2026-07',
      input: 0.14,
      cached: 0.0028,
      output: 0.28,
      source: 'DeepSeek API pricing',
      // DeepSeek exposes prompt_cache_miss_tokens. EchoLink historically
      // stores that field as cacheWriteTokens, but it is normal uncached
      // input for billing, not a premium cache-write category.
      cacheWriteSemantics: 'uncached'
    })
  }

  if (/^deepseek-v4-pro(?:$|-)/i.test(id)) {
    return pricing({
      key: 'deepseek:v4-pro:2026-08',
      input: 0.435,
      cached: 0.003625,
      output: 0.87,
      source: 'DeepSeek API pricing',
      cacheWriteSemantics: 'uncached'
    })
  }

  return null
}

function zaiPricing(id, createdAt) {
  const lower = String(id || '').toLowerCase()
  const timestamp = Number(createdAt) || Math.floor(Date.now() / 1000)

  if (lower === 'glm-5.3-flash') {
    // Launch promo is pinned through 2026-09-09 inclusive. The regular
    // fallback is deliberately a separate pricing key so historical events
    // retain the rate that was used for their calculation.
    const promoEnd =
      Math.floor(Date.parse('2026-09-10T00:00:00Z') / 1000)

    if (timestamp < promoEnd) {
      return pricing({
        key: 'zai:glm-5.3-flash:launch-promo-2026-08-26',
        input: 0.075,
        cached: 0.015,
        output: 0.25,
        source: 'Z.ai GLM-5.3-Flash launch pricing'
      })
    }

    return pricing({
      key: 'zai:glm-5.3-flash:list',
      input: 0.15,
      cached: 0.03,
      output: 0.50,
      source: 'Z.ai GLM-5.3-Flash list pricing'
    })
  }

  const exact = {
    'glm-5.2': [1.4, 0.26, 4.4],
    'glm-5.1': [1.4, 0.26, 4.4],
    'glm-5': [1.0, 0.2, 3.2],
    'glm-5-turbo': [1.2, 0.24, 4.0],
    'glm-4.7': [0.6, 0.11, 2.2],
    'glm-4.7-flashx': [0.07, 0.01, 0.4],
    'glm-4.6': [0.6, 0.11, 2.2],
    'glm-4.5': [0.6, 0.11, 2.2],
    'glm-4.5-x': [2.2, 0.45, 8.9],
    'glm-4.5-air': [0.2, 0.03, 1.1],
    'glm-4.5-airx': [1.1, 0.22, 4.5],
    'glm-4-32b-0414-128k': [0.1, 0.1, 0.1],
    'glm-4.7-flash': [0, 0, 0],
    'glm-4.5-flash': [0, 0, 0]
  }

  const row = exact[lower]
  if (!row) return null

  return pricing({
    key: `zai:${lower}`,
    input: row[0],
    cached: row[1],
    output: row[2],
    source: 'Z.ai API pricing'
  })
}

function kimiPricing(id) {
  const lower = String(id || '').toLowerCase()

  if (lower === 'kimi-k3-fast') {
    return pricing({
      key: 'kimi:k3-fast',
      input: 4.5,
      cached: 0.45,
      output: 22.5,
      source: 'Moonshot Kimi API pricing'
    })
  }

  if (lower === 'kimi-k3') {
    return pricing({
      key: 'kimi:k3',
      input: 3.0,
      cached: 0.30,
      output: 15.0,
      source: 'Moonshot Kimi API pricing'
    })
  }

  if (lower === 'kimi-k2.7-code') {
    return pricing({
      key: 'kimi:k2.7-code',
      input: 0.95,
      cached: 0.19,
      output: 4.0,
      source: 'Moonshot Kimi API pricing'
    })
  }

  if (lower.startsWith('kimi-k2.6')) {
    return pricing({
      key: 'kimi:k2.6',
      input: 0.95,
      cached: 0.16,
      output: 4.0,
      source: 'Moonshot Kimi API pricing'
    })
  }

  if (lower.startsWith('kimi-k2.5')) {
    return pricing({
      key: 'kimi:k2.5',
      input: 0.60,
      cached: 0.10,
      output: 3.0,
      source: 'Moonshot Kimi API pricing'
    })
  }

  return null
}

export function resolveModelPricing(
  model,
  createdAt = Math.floor(Date.now() / 1000)
) {
  const provider = providerForModel(model)
  const id = providerModelId(model)

  if (
    provider === 'ollama' ||
    provider === 'llamacpp'
  ) {
    return pricing({
      key: `${provider}:local`,
      input: 0,
      cached: 0,
      cacheWrite: 0,
      output: 0,
      source: 'Local inference',
      local: true
    })
  }

  if (provider === 'ollama-cloud') {
    // Ollama Cloud is plan/provider dependent and is not safely reducible
    // to a universal token price.
    return null
  }

  if (provider === 'openai') {
    return openAiPricing(id)
  }

  if (provider === 'anthropic') {
    return anthropicPricing(id)
  }

  if (provider === 'deepseek') {
    return deepSeekPricing(id)
  }

  if (provider === 'zai') {
    return zaiPricing(id, createdAt)
  }

  if (provider === 'kimi') {
    return kimiPricing(id)
  }

  return null
}

export function normalizeUsageForCost(usage) {
  if (!usage || typeof usage !== 'object') return null

  const promptTokens = finiteNonNegative(
    usage.promptTokens ??
    usage.prompt_tokens ??
    usage.input_tokens
  )

  const completionTokens = finiteNonNegative(
    usage.completionTokens ??
    usage.completion_tokens ??
    usage.output_tokens
  )

  const cachedTokens = finiteNonNegative(
    usage.cachedTokens ??
    usage.cached_tokens ??
    usage.prompt_cache_hit_tokens ??
    usage.prompt_tokens_details?.cached_tokens ??
    usage.input_tokens_details?.cached_tokens
  )

  const cacheWriteTokens = finiteNonNegative(
    usage.cacheWriteTokens ??
    usage.cache_write_tokens ??
    usage.prompt_cache_miss_tokens ??
    usage.input_tokens_details?.cache_write_tokens
  )

  const totalTokens = finiteNonNegative(
    usage.totalTokens ??
    usage.total_tokens
  ) || promptTokens + completionTokens

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cachedTokens,
    cacheWriteTokens
  }
}

export function normalizeOpenAICompatibleUsage(usage) {
  if (!usage || typeof usage !== 'object') return null

  const promptTokens =
    finiteNonNegative(usage.prompt_tokens)
  const completionTokens =
    finiteNonNegative(usage.completion_tokens)

  return {
    promptTokens,
    completionTokens,
    totalTokens:
      finiteNonNegative(usage.total_tokens) ||
      promptTokens + completionTokens,
    cachedTokens:
      finiteNonNegative(
        usage.prompt_cache_hit_tokens ??
        usage.prompt_tokens_details?.cached_tokens
      ),
    cacheWriteTokens:
      finiteNonNegative(
        usage.prompt_cache_miss_tokens
      ),
    cacheObserved:
      usage.prompt_cache_hit_tokens !== undefined ||
      usage.prompt_cache_miss_tokens !== undefined ||
      usage.prompt_tokens_details?.cached_tokens !== undefined
  }
}

export function normalizeResponsesUsageForCost(usage) {
  if (!usage || typeof usage !== 'object') return null

  const promptTokens =
    finiteNonNegative(usage.input_tokens)
  const completionTokens =
    finiteNonNegative(usage.output_tokens)

  return {
    promptTokens,
    completionTokens,
    totalTokens:
      finiteNonNegative(usage.total_tokens) ||
      promptTokens + completionTokens,
    cachedTokens:
      finiteNonNegative(
        usage.input_tokens_details?.cached_tokens
      ),
    cacheWriteTokens:
      finiteNonNegative(
        usage.input_tokens_details?.cache_write_tokens
      ),
    cacheObserved:
      usage.input_tokens_details?.cached_tokens !== undefined ||
      usage.input_tokens_details?.cache_write_tokens !== undefined
  }
}

export function estimateModelUsageCost(
  model,
  usage,
  createdAt = Math.floor(Date.now() / 1000)
) {
  const normalized = normalizeUsageForCost(usage)
  const provider = providerForModel(model)
  const price = resolveModelPricing(model, createdAt)

  if (!normalized || !price) {
    return {
      priced: false,
      costUsd: null,
      pricingKey: '',
      provider,
      model: String(model || ''),
      pricing: price,
      usage: normalized
    }
  }

  const promptTokens = normalized.promptTokens
  const cachedTokens = clamp(
    normalized.cachedTokens,
    0,
    promptTokens
  )

  let cacheWriteTokens = clamp(
    normalized.cacheWriteTokens,
    0,
    Math.max(0, promptTokens - cachedTokens)
  )

  let uncachedTokens

  if (price.cacheWriteSemantics === 'uncached') {
    // DeepSeek's "miss" field is not a premium write category.
    uncachedTokens = Math.max(
      0,
      promptTokens - cachedTokens
    )
    cacheWriteTokens = 0
  } else {
    uncachedTokens = Math.max(
      0,
      promptTokens -
        cachedTokens -
        cacheWriteTokens
    )
  }

  const costUsd = (
    uncachedTokens * price.inputPerMillion +
    cachedTokens * price.cachedPerMillion +
    cacheWriteTokens * price.cacheWritePerMillion +
    normalized.completionTokens * price.outputPerMillion
  ) / 1_000_000

  return {
    priced: true,
    costUsd,
    pricingKey: price.key,
    provider,
    model: String(model || ''),
    pricing: price,
    usage: normalized,
    components: {
      uncachedTokens,
      cachedTokens,
      cacheWriteTokens,
      completionTokens: normalized.completionTokens
    }
  }
}
