import {
  estimateModelUsageCost,
  normalizeUsageForCost,
  providerForModel
} from './modelCosts.js'

function safeJson(value) {
  try {
    return JSON.parse(String(value || ''))
  } catch {
    return null
  }
}

function finiteCost(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0
    ? number
    : null
}

function emptySummary() {
  return {
    trackingSince: null,
    totalUsd: 0,
    last24hUsd: 0,
    last7dUsd: 0,
    chatUsd: 0,
    memoryUsd: 0,
    summaryUsd: 0,
    events: 0,
    pricedEvents: 0,
    unpricedEvents: 0,
    providers: []
  }
}

export function summarizeModelCostEntries(
  entries,
  nowSeconds = Math.floor(Date.now() / 1000)
) {
  const summary = emptySummary()
  const providers = new Map()
  const last24h = nowSeconds - 24 * 60 * 60
  const last7d = nowSeconds - 7 * 24 * 60 * 60

  for (const entry of entries || []) {
    const createdAt = Number(entry.createdAt) || 0
    const provider =
      entry.provider ||
      providerForModel(entry.model)

    let bucket = providers.get(provider)

    if (!bucket) {
      bucket = {
        provider,
        costUsd: 0,
        chatUsd: 0,
        memoryUsd: 0,
        summaryUsd: 0,
        events: 0,
        pricedEvents: 0,
        unpricedEvents: 0
      }
      providers.set(provider, bucket)
    }

    summary.events += 1
    bucket.events += 1

    if (
      createdAt > 0 &&
      (
        summary.trackingSince === null ||
        createdAt < summary.trackingSince
      )
    ) {
      summary.trackingSince = createdAt
    }

    if (!entry.priced) {
      summary.unpricedEvents += 1
      bucket.unpricedEvents += 1
      continue
    }

    const cost = finiteCost(entry.costUsd)

    if (cost === null) {
      summary.unpricedEvents += 1
      bucket.unpricedEvents += 1
      continue
    }

    summary.pricedEvents += 1
    bucket.pricedEvents += 1
    summary.totalUsd += cost
    bucket.costUsd += cost

    if (entry.purpose === 'memory') {
      summary.memoryUsd += cost
      bucket.memoryUsd += cost
    } else if (entry.purpose === 'conversation_summary') {
      summary.summaryUsd += cost
      bucket.summaryUsd += cost
    } else {
      summary.chatUsd += cost
      bucket.chatUsd += cost
    }

    if (createdAt >= last24h) {
      summary.last24hUsd += cost
    }

    if (createdAt >= last7d) {
      summary.last7dUsd += cost
    }
  }

  summary.providers = [...providers.values()]
    .sort((left, right) => {
      if (right.costUsd !== left.costUsd) {
        return right.costUsd - left.costUsd
      }
      return left.provider.localeCompare(right.provider)
    })

  return summary
}

export function recordModelUsageEvent(
  db,
  {
    userId,
    conversationId = null,
    purpose,
    model,
    usage,
    createdAt = Math.floor(Date.now() / 1000)
  }
) {
  const normalized = normalizeUsageForCost(usage)

  if (!normalized) {
    return {
      recorded: false,
      reason: 'missing_usage'
    }
  }

  const estimate =
    estimateModelUsageCost(
      model,
      normalized,
      createdAt
    )

  const provider =
    estimate.provider ||
    providerForModel(model)

  const result = db.prepare(`
    INSERT INTO model_usage_events (
      user_id,
      conversation_id,
      purpose,
      provider,
      model,
      prompt_tokens,
      cached_tokens,
      cache_write_tokens,
      completion_tokens,
      total_tokens,
      cost_usd,
      priced,
      pricing_key,
      pricing_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    conversationId,
    String(purpose || 'background'),
    provider,
    String(model || ''),
    normalized.promptTokens,
    normalized.cachedTokens,
    normalized.cacheWriteTokens,
    normalized.completionTokens,
    normalized.totalTokens,
    estimate.priced
      ? estimate.costUsd
      : null,
    estimate.priced ? 1 : 0,
    estimate.pricingKey || '',
    JSON.stringify(
      estimate.pricing || {}
    ),
    createdAt
  )

  return {
    recorded: true,
    id: Number(result.lastInsertRowid),
    priced: estimate.priced,
    costUsd: estimate.costUsd,
    pricingKey: estimate.pricingKey,
    provider
  }
}

function chatCostEntries(db, userId) {
  const rows = db.prepare(`
    SELECT
      messages.created_at,
      messages.usage
    FROM messages
    INNER JOIN conversations
      ON conversations.id =
        messages.conversation_id
    WHERE conversations.user_id = ?
      AND messages.role = 'assistant'
      AND messages.usage IS NOT NULL
      AND trim(messages.usage) <> ''
  `).all(userId)

  const entries = []

  for (const row of rows) {
    const usage = safeJson(row.usage)
    if (!usage) continue

    const normalized = normalizeUsageForCost(usage)
    if (!normalized) continue

    const model =
      String(usage.context_model || '').trim()

    if (!model) continue

    const storedCost =
      finiteCost(usage.cost_usd)

    let estimate

    if (
      usage.cost_priced === true &&
      storedCost !== null
    ) {
      estimate = {
        priced: true,
        costUsd: storedCost,
        provider: providerForModel(model)
      }
    } else {
      estimate = estimateModelUsageCost(
        model,
        normalized,
        row.created_at
      )
    }

    entries.push({
      createdAt: row.created_at,
      purpose: 'chat',
      provider: estimate.provider,
      model,
      priced: estimate.priced,
      costUsd: estimate.costUsd
    })
  }

  return entries
}

function backgroundCostEntries(db, userId) {
  return db.prepare(`
    SELECT
      created_at,
      purpose,
      provider,
      model,
      prompt_tokens,
      cached_tokens,
      cache_write_tokens,
      completion_tokens,
      total_tokens,
      cost_usd,
      priced
    FROM model_usage_events
    WHERE user_id = ?
  `).all(userId).map(row => {
    if (row.priced === 1) {
      return {
        createdAt: row.created_at,
        purpose: row.purpose,
        provider: row.provider,
        model: row.model,
        priced: true,
        costUsd: row.cost_usd
      }
    }

    const estimate = estimateModelUsageCost(
      row.model,
      {
        promptTokens: row.prompt_tokens,
        cachedTokens: row.cached_tokens,
        cacheWriteTokens:
          row.cache_write_tokens,
        completionTokens:
          row.completion_tokens,
        totalTokens: row.total_tokens
      },
      row.created_at
    )

    return {
      createdAt: row.created_at,
      purpose: row.purpose,
      provider:
        estimate.provider ||
        row.provider,
      model: row.model,
      priced: estimate.priced,
      costUsd: estimate.costUsd
    }
  })
}

export function getModelCostSummary(db, userId) {
  const entries = [
    ...chatCostEntries(db, userId),
    ...backgroundCostEntries(db, userId)
  ]

  return summarizeModelCostEntries(entries)
}
