import {
  CONVERSATION_SUMMARY_PROMPT_VERSION,
  SUMMARY_CALL_TIMEOUT_MS,
  SUMMARY_DEFAULT_OUTPUT_TOKENS,
  SUMMARY_MAX_CHARS,
  SUMMARY_PART_OUTPUT_TOKENS,
  SUMMARY_TOTAL_TIMEOUT_MS,
  buildContinuationMessage,
  buildConversationSnapshot,
  buildPartialSummaryMessages,
  buildSingleSummaryMessages,
  buildSynthesisMessages,
  continuationTitle,
  planSummaryGeneration,
  summaryContentHash,
  validateSummaryContent
} from './conversationSummary.js'
import { runConversationSummaryProvider } from './conversationSummaryProvider.js'
import { recordModelUsageEvent } from './modelUsageLedger.js'
import { isValidChatRequestId } from './chatCancellation.js'

export class ConversationSummaryError extends Error {
  constructor(message, { status = 400, code = 'SUMMARY_ERROR' } = {}) {
    super(message)
    this.name = 'ConversationSummaryError'
    this.status = status
    this.statusCode = status
    this.code = code
    this.expose = true
  }
}

function asSummaryError(error) {
  if (error instanceof ConversationSummaryError) return error
  if (error?.name === 'AbortError') {
    return new ConversationSummaryError('Zusammenfassung abgebrochen.', {
      status: 499,
      code: 'SUMMARY_CANCELLED'
    })
  }
  if (Number.isInteger(error?.status) && error.status >= 400) {
    return new ConversationSummaryError(error.message || 'Summary error', {
      status: error.status,
      code: error.code || 'SUMMARY_ERROR'
    })
  }
  return error
}

function positiveId(value, label = 'ID') {
  const id = Number(value)
  if (!Number.isInteger(id) || id <= 0) {
    throw new ConversationSummaryError(`${label} ist ungültig.`, {
      status: 400,
      code: 'SUMMARY_INVALID_ID'
    })
  }
  return id
}

function revisionValue(value) {
  const revision = Number(value)
  if (!Number.isInteger(revision) || revision <= 0) {
    throw new ConversationSummaryError('expectedRevision ist ungültig.', {
      status: 400,
      code: 'SUMMARY_INVALID_REVISION'
    })
  }
  return revision
}

function validRequestId(value) {
  if (!isValidChatRequestId(value)) {
    throw new ConversationSummaryError('Ungültige Summary-Request-ID.', {
      status: 400,
      code: 'SUMMARY_INVALID_REQUEST_ID'
    })
  }
  return String(value)
}

function validateEditableContent(value) {
  const content = String(value || '').trim()
  if (!content) {
    throw new ConversationSummaryError('Die Zusammenfassung darf nicht leer sein.', {
      status: 400,
      code: 'SUMMARY_EMPTY_CONTENT'
    })
  }
  if (content.length > SUMMARY_MAX_CHARS) {
    throw new ConversationSummaryError(
      `Die Zusammenfassung darf höchstens ${SUMMARY_MAX_CHARS} Zeichen enthalten.`,
      { status: 413, code: 'SUMMARY_CONTENT_TOO_LONG' }
    )
  }
  return content
}

function rowToSummary(row) {
  if (!row) return null
  return {
    id: Number(row.id),
    sourceConversationId: Number(row.source_conversation_id),
    content: row.content,
    model: row.model,
    promptVersion: row.prompt_version,
    sourceLastMessageId: row.source_last_message_id == null
      ? null
      : Number(row.source_last_message_id),
    sourceMessageCount: Number(row.source_message_count) || 0,
    sourceHash: row.source_hash,
    revision: Number(row.revision),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    continuedConversationId: row.continued_conversation_id == null
      ? null
      : Number(row.continued_conversation_id),
    continuedRevision: row.continued_revision == null
      ? null
      : Number(row.continued_revision)
  }
}

function ownedConversation(db, userId, conversationId) {
  return db.prepare(`
    SELECT
      id,
      user_id,
      title,
      model,
      system_prompt,
      temperature,
      top_k,
      top_p,
      reasoning_effort,
      archived_at,
      created_at,
      updated_at
    FROM conversations
    WHERE id = ? AND user_id = ?
  `).get(conversationId, userId)
}

function snapshotFor(db, userId, conversationId) {
  const conversation = ownedConversation(db, userId, conversationId)
  if (!conversation) {
    throw new ConversationSummaryError('Not found', {
      status: 404,
      code: 'SUMMARY_NOT_FOUND'
    })
  }

  const rows = db.prepare(`
    SELECT id, role, content, images, created_at
    FROM messages
    WHERE conversation_id = ?
    ORDER BY id ASC
  `).all(conversationId)

  return {
    conversation,
    snapshot: buildConversationSnapshot(conversation, rows)
  }
}

function summaryRow(db, userId, conversationId) {
  return db.prepare(`
    SELECT *
    FROM conversation_summaries
    WHERE source_conversation_id = ? AND user_id = ?
  `).get(conversationId, userId)
}

function ensureSourceReady(snapshot, activeRun) {
  if (snapshot.sourceMessageCount === 0) {
    throw new ConversationSummaryError('Ein leerer Chat kann nicht zusammengefasst werden.', {
      status: 400,
      code: 'SUMMARY_EMPTY_SOURCE'
    })
  }
  if (activeRun) {
    throw new ConversationSummaryError(
      'Während in diesem Chat noch eine Antwort oder Tool-Aktion läuft, kann keine Zusammenfassung erstellt oder übernommen werden.',
      { status: 409, code: 'SUMMARY_SOURCE_ACTIVE' }
    )
  }
}

function summaryPlan(snapshot, model, env) {
  try {
    return planSummaryGeneration(snapshot, model, env)
  } catch (error) {
    throw asSummaryError(error)
  }
}

function linkAbort(parentSignal, timeoutMs) {
  const controller = new AbortController()
  let timedOut = false
  const onAbort = () => controller.abort(parentSignal?.reason)

  if (parentSignal?.aborted) {
    controller.abort(parentSignal.reason)
  } else if (parentSignal) {
    parentSignal.addEventListener('abort', onAbort, { once: true })
  }

  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new Error('timeout'))
  }, Math.max(1, timeoutMs))
  timer.unref?.()

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup() {
      clearTimeout(timer)
      parentSignal?.removeEventListener?.('abort', onAbort)
    }
  }
}

function generationKey(userId, conversationId) {
  return `${Number(userId)}:${Number(conversationId)}`
}

export function createConversationSummaryService({
  db,
  runProvider = runConversationSummaryProvider,
  recordUsage = recordModelUsageEvent,
  hasActiveChatRun = () => false,
  env = process.env,
  hooks = {}
}) {
  if (!db) throw new TypeError('db is required')
  const activeGenerations = new Map()

  function currentSummaryState(userId, conversationId, requestedModel) {
    const sourceId = positiveId(conversationId, 'Conversation-ID')
    const { conversation, snapshot } = snapshotFor(db, userId, sourceId)
    const stored = summaryRow(db, userId, sourceId)
    const model = String(requestedModel || conversation.model || '').trim()
    let generationPlan = null
    let planError = null

    if (snapshot.sourceMessageCount > 0 && model) {
      try {
        const plan = summaryPlan(snapshot, model, env)
        generationPlan = {
          calls: plan.calls,
          mode: plan.mode,
          budgetTokens: plan.budgetTokens,
          budgetSource: plan.budgetSource,
          estimatedSourceTokens: plan.estimatedSourceTokens
        }
      } catch (error) {
        planError = {
          code: error.code || 'SUMMARY_PLAN_ERROR',
          message: error.message
        }
      }
    }

    return {
      source: {
        id: sourceId,
        title: conversation.title,
        model: conversation.model,
        messageCount: snapshot.sourceMessageCount
      },
      summary: rowToSummary(stored),
      stale: Boolean(stored && stored.source_hash !== snapshot.sourceHash),
      activeRun: Boolean(hasActiveChatRun(userId, sourceId)),
      generationPlan,
      planError
    }
  }

  function recordCompletedCall({ userId, conversationId, model, result }) {
    let recorded
    try {
      recorded = recordUsage(db, {
        userId,
        conversationId,
        purpose: 'conversation_summary',
        model,
        usage: result?.tokenUsage
      })
    } catch (error) {
      console.error('Summary usage recording failed:', error?.message || error)
      recorded = { recorded: false, reason: 'ledger_error' }
    }

    if (recorded?.recorded) return recorded

    // A completed provider call without usage metadata is still a real call.
    // Store it explicitly as unpriced/unknown instead of silently treating it as free.
    try {
      const provider = String(result?.provider || 'unknown')
      const inserted = db.prepare(`
        INSERT INTO model_usage_events (
          user_id, conversation_id, purpose, provider, model,
          prompt_tokens, cached_tokens, cache_write_tokens,
          completion_tokens, total_tokens, cost_usd, priced,
          pricing_key, pricing_json, created_at
        ) VALUES (?, ?, 'conversation_summary', ?, ?, 0, 0, 0, 0, 0, NULL, 0, '', ?, unixepoch())
      `).run(
        userId,
        conversationId,
        provider,
        String(model || ''),
        JSON.stringify({ reason: recorded?.reason || 'missing_usage' })
      )
      return {
        recorded: true,
        id: Number(inserted.lastInsertRowid),
        priced: false,
        costUsd: null,
        provider
      }
    } catch (error) {
      console.error('Summary unknown-usage recording failed:', error?.message || error)
      return { recorded: false, priced: false, costUsd: null }
    }
  }

  async function providerCall({
    userId,
    conversationId,
    model,
    messages,
    maxTokens,
    generationSignal,
    deadline,
    costState,
    snapshot
  }) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new ConversationSummaryError('Gesamtlaufzeit der Zusammenfassung überschritten.', {
        status: 504,
        code: 'SUMMARY_TOTAL_TIMEOUT'
      })
    }

    const timeoutMs = Math.min(
      Math.max(1, Number(env.CONVERSATION_SUMMARY_CALL_TIMEOUT_MS) || SUMMARY_CALL_TIMEOUT_MS),
      remaining
    )
    const linked = linkAbort(generationSignal, timeoutMs)
    let result

    try {
      result = await runProvider({
        model,
        messages,
        maxTokens,
        tools: [],
        signal: linked.signal
      })
    } catch (error) {
      if (generationSignal.aborted) throw error
      if (linked.timedOut()) {
        throw new ConversationSummaryError('Zeitlimit für einen Summary-Modellaufruf überschritten.', {
          status: 504,
          code: 'SUMMARY_CALL_TIMEOUT'
        })
      }
      throw error
    } finally {
      linked.cleanup()
    }

    const usage = recordCompletedCall({
      userId,
      conversationId,
      model,
      result
    })
    costState.calls += 1
    if (usage?.priced && Number.isFinite(Number(usage.costUsd))) {
      costState.pricedCalls += 1
      costState.knownUsd += Number(usage.costUsd)
    } else {
      costState.unpricedCalls += 1
    }

    if (result?.completed !== true) {
      throw new ConversationSummaryError('Der Modellstream endete unvollständig; der vorhandene Entwurf bleibt unverändert.', {
        status: 502,
        code: 'SUMMARY_INCOMPLETE_STREAM'
      })
    }
    if (Array.isArray(result?.toolCalls) && result.toolCalls.length > 0) {
      throw new ConversationSummaryError('Das Summary-Modell hat unerwartet einen Tool-Aufruf angefordert.', {
        status: 502,
        code: 'SUMMARY_TOOL_CALL'
      })
    }

    const validated = validateSummaryContent(result?.fullContent, snapshot)
    const callCharLimit = Math.min(SUMMARY_MAX_CHARS, Math.max(2_000, Number(maxTokens || 0) * 4))
    if (validated.length > callCharLimit) {
      throw new ConversationSummaryError('Der Summary-Modellaufruf hat sein vorgesehenes Ausgabelimit überschritten.', {
        status: 502,
        code: 'SUMMARY_CALL_OUTPUT_TOO_LONG'
      })
    }
    return validated
  }

  async function runGeneration({ userId, conversationId, model, controller }) {
    const source = snapshotFor(db, userId, conversationId)
    ensureSourceReady(
      source.snapshot,
      hasActiveChatRun(userId, conversationId)
    )
    const plan = summaryPlan(source.snapshot, model, env)
    const costState = {
      calls: 0,
      pricedCalls: 0,
      unpricedCalls: 0,
      knownUsd: 0
    }
    const deadline = Date.now() + Math.max(
      1_000,
      Number(env.CONVERSATION_SUMMARY_TOTAL_TIMEOUT_MS) || SUMMARY_TOTAL_TIMEOUT_MS
    )

    let finalContent
    if (plan.mode === 'single') {
      finalContent = await providerCall({
        userId,
        conversationId,
        model,
        messages: buildSingleSummaryMessages(source.snapshot),
        maxTokens: Math.max(
          2_000,
          Number(env.CONVERSATION_SUMMARY_OUTPUT_TOKENS) || SUMMARY_DEFAULT_OUTPUT_TOKENS
        ),
        generationSignal: controller.signal,
        deadline,
        costState,
        snapshot: source.snapshot
      })
    } else {
      const partials = []
      for (let index = 0; index < plan.chunks.length; index += 1) {
        if (controller.signal.aborted) {
          const error = new Error('cancelled')
          error.name = 'AbortError'
          throw error
        }
        partials.push(await providerCall({
          userId,
          conversationId,
          model,
          messages: buildPartialSummaryMessages(
            source.snapshot,
            plan.chunks[index],
            index,
            plan.chunks.length
          ),
          maxTokens: Math.max(
            512,
            Number(env.CONVERSATION_SUMMARY_PART_OUTPUT_TOKENS) || SUMMARY_PART_OUTPUT_TOKENS
          ),
          generationSignal: controller.signal,
          deadline,
          costState,
          snapshot: source.snapshot
        }))
      }

      finalContent = await providerCall({
        userId,
        conversationId,
        model,
        messages: buildSynthesisMessages(source.snapshot, partials),
        maxTokens: Math.max(
          2_000,
          Number(env.CONVERSATION_SUMMARY_OUTPUT_TOKENS) || SUMMARY_DEFAULT_OUTPUT_TOKENS
        ),
        generationSignal: controller.signal,
        deadline,
        costState,
        snapshot: source.snapshot
      })
    }

    if (controller.signal.aborted) {
      const error = new Error('cancelled')
      error.name = 'AbortError'
      throw error
    }

    const persist = db.transaction(() => {
      const fresh = snapshotFor(db, userId, conversationId)
      ensureSourceReady(
        fresh.snapshot,
        hasActiveChatRun(userId, conversationId)
      )
      if (fresh.snapshot.sourceHash !== source.snapshot.sourceHash) {
        throw new ConversationSummaryError(
          'Der Quellchat wurde während der Erstellung verändert. Der bisherige Entwurf bleibt erhalten.',
          { status: 409, code: 'SUMMARY_SOURCE_CHANGED' }
        )
      }

      db.prepare(`
        INSERT INTO conversation_summaries (
          user_id, source_conversation_id, content, model, prompt_version,
          source_last_message_id, source_message_count, source_hash,
          revision, created_at, updated_at,
          continued_conversation_id, continued_revision,
          continue_request_id, continue_content_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, unixepoch(), unixepoch(), NULL, NULL, NULL, NULL)
        ON CONFLICT(source_conversation_id) DO UPDATE SET
          content = excluded.content,
          model = excluded.model,
          prompt_version = excluded.prompt_version,
          source_last_message_id = excluded.source_last_message_id,
          source_message_count = excluded.source_message_count,
          source_hash = excluded.source_hash,
          revision = conversation_summaries.revision + 1,
          updated_at = unixepoch(),
          continued_conversation_id = NULL,
          continued_revision = NULL,
          continue_request_id = NULL,
          continue_content_hash = NULL
        WHERE conversation_summaries.user_id = excluded.user_id
      `).run(
        userId,
        conversationId,
        finalContent,
        model,
        CONVERSATION_SUMMARY_PROMPT_VERSION,
        source.snapshot.sourceLastMessageId,
        source.snapshot.sourceMessageCount,
        source.snapshot.sourceHash
      )

      return summaryRow(db, userId, conversationId)
    })

    const stored = persist()
    return {
      summary: rowToSummary(stored),
      stale: false,
      generationPlan: {
        mode: plan.mode,
        calls: plan.calls
      },
      cost: {
        calls: costState.calls,
        knownUsd: costState.knownUsd,
        pricedCalls: costState.pricedCalls,
        unpricedCalls: costState.unpricedCalls,
        complete: costState.unpricedCalls === 0
      }
    }
  }

  async function generate(userId, conversationId, { model, requestId } = {}) {
    const sourceId = positiveId(conversationId, 'Conversation-ID')
    validRequestId(requestId)
    const { conversation, snapshot } = snapshotFor(db, userId, sourceId)
    const selectedModel = String(model || conversation.model || '').trim()
    if (!selectedModel) {
      throw new ConversationSummaryError('Kein Zusammenfassungsmodell gewählt.', {
        status: 400,
        code: 'SUMMARY_MODEL_REQUIRED'
      })
    }
    if (selectedModel.length > 200 || /[\r\n\0]/.test(selectedModel)) {
      throw new ConversationSummaryError('Ungültiger Modellname.', {
        status: 400,
        code: 'SUMMARY_INVALID_MODEL'
      })
    }
    ensureSourceReady(snapshot, hasActiveChatRun(userId, sourceId))
    summaryPlan(snapshot, selectedModel, env) // rejects too-large jobs before registration/provider calls

    const key = generationKey(userId, sourceId)
    const existing = activeGenerations.get(key)
    if (existing) {
      if (existing.requestId !== requestId || existing.model !== selectedModel) {
        throw new ConversationSummaryError('Für diesen Chat läuft bereits eine Zusammenfassung.', {
          status: 409,
          code: 'SUMMARY_ALREADY_RUNNING'
        })
      }
      return existing.promise
    }

    const controller = new AbortController()
    const entry = {
      requestId,
      model: selectedModel,
      controller,
      promise: null
    }
    entry.promise = runGeneration({
      userId,
      conversationId: sourceId,
      model: selectedModel,
      controller
    }).catch(error => {
      throw asSummaryError(error)
    }).finally(() => {
      if (activeGenerations.get(key) === entry) activeGenerations.delete(key)
    })
    activeGenerations.set(key, entry)
    return entry.promise
  }

  function cancel(userId, conversationId, requestId) {
    const sourceId = positiveId(conversationId, 'Conversation-ID')
    validRequestId(requestId)
    snapshotFor(db, userId, sourceId) // ownership before looking at registry
    const entry = activeGenerations.get(generationKey(userId, sourceId))
    if (!entry || entry.requestId !== requestId) return { cancelled: false }
    entry.controller.abort()
    return { cancelled: true }
  }

  function save(userId, conversationId, { content, expectedRevision } = {}) {
    const sourceId = positiveId(conversationId, 'Conversation-ID')
    const revision = revisionValue(expectedRevision)
    const text = validateEditableContent(content)
    const fresh = snapshotFor(db, userId, sourceId)
    validateSummaryContent(text, fresh.snapshot)
    const stored = summaryRow(db, userId, sourceId)
    if (!stored) {
      throw new ConversationSummaryError('Kein gespeicherter Summary-Entwurf vorhanden.', {
        status: 404,
        code: 'SUMMARY_DRAFT_NOT_FOUND'
      })
    }
    if (stored.source_hash !== fresh.snapshot.sourceHash) {
      throw new ConversationSummaryError('Der Quellchat hat sich geändert. Bitte erst eine neue Zusammenfassung erstellen.', {
        status: 409,
        code: 'SUMMARY_SOURCE_CHANGED'
      })
    }
    if (stored.continued_conversation_id != null) {
      throw new ConversationSummaryError('Diese Summary-Version wurde bereits übernommen. Erstelle für eine weitere Fortsetzung zuerst eine neue Zusammenfassung.', {
        status: 409,
        code: 'SUMMARY_ALREADY_CONTINUED'
      })
    }

    const result = db.prepare(`
      UPDATE conversation_summaries
      SET content = ?, revision = revision + 1, updated_at = unixepoch()
      WHERE source_conversation_id = ? AND user_id = ? AND revision = ?
    `).run(text, sourceId, userId, revision)

    if (result.changes !== 1) {
      throw new ConversationSummaryError('Der Entwurf wurde in einem anderen Tab geändert. Bitte neu laden.', {
        status: 409,
        code: 'SUMMARY_REVISION_CONFLICT'
      })
    }
    return { summary: rowToSummary(summaryRow(db, userId, sourceId)), stale: false }
  }

  function continueFromSummary(userId, conversationId, {
    content,
    expectedRevision,
    requestId
  } = {}) {
    const sourceId = positiveId(conversationId, 'Conversation-ID')
    const requestedRevision = revisionValue(expectedRevision)
    const text = validateEditableContent(content)
    const idempotencyKey = validRequestId(requestId)
    const contentHash = summaryContentHash(text)

    const transaction = db.transaction(() => {
      const fresh = snapshotFor(db, userId, sourceId)
      ensureSourceReady(fresh.snapshot, hasActiveChatRun(userId, sourceId))
      validateSummaryContent(text, fresh.snapshot)
      const stored = summaryRow(db, userId, sourceId)
      if (!stored) {
        throw new ConversationSummaryError('Kein gespeicherter Summary-Entwurf vorhanden.', {
          status: 404,
          code: 'SUMMARY_DRAFT_NOT_FOUND'
        })
      }

      if (stored.continue_request_id === idempotencyKey) {
        if (stored.continue_content_hash !== contentHash) {
          throw new ConversationSummaryError('Diese Continue-Request-ID wurde bereits mit anderem Inhalt verwendet.', {
            status: 409,
            code: 'SUMMARY_CONTINUE_ID_CONFLICT'
          })
        }
        if (stored.continued_conversation_id == null) {
          throw new ConversationSummaryError('Unvollständiger idempotenter Continue-Zustand.', {
            status: 409,
            code: 'SUMMARY_CONTINUE_STATE_CONFLICT'
          })
        }
        const target = ownedConversation(db, userId, stored.continued_conversation_id)
        if (!target) {
          throw new ConversationSummaryError('Der bereits erzeugte Zielchat ist nicht mehr vorhanden.', {
            status: 409,
            code: 'SUMMARY_CONTINUE_TARGET_MISSING'
          })
        }
        return {
          conversation: target,
          summary: rowToSummary(stored),
          restored: true
        }
      }

      if (stored.source_hash !== fresh.snapshot.sourceHash) {
        throw new ConversationSummaryError('Der Quellchat hat sich geändert. Bitte erst eine neue Zusammenfassung erstellen.', {
          status: 409,
          code: 'SUMMARY_SOURCE_CHANGED'
        })
      }
      if (Number(stored.revision) !== requestedRevision) {
        throw new ConversationSummaryError('Der Entwurf wurde in einem anderen Tab geändert. Bitte neu laden.', {
          status: 409,
          code: 'SUMMARY_REVISION_CONFLICT'
        })
      }
      if (stored.continued_conversation_id != null) {
        throw new ConversationSummaryError('Diese Summary-Version wurde bereits in einen neuen Chat übernommen.', {
          status: 409,
          code: 'SUMMARY_ALREADY_CONTINUED'
        })
      }

      let finalRevision = requestedRevision
      if (stored.content !== text) {
        db.prepare(`
          UPDATE conversation_summaries
          SET content = ?, revision = revision + 1, updated_at = unixepoch()
          WHERE id = ? AND revision = ?
        `).run(text, stored.id, requestedRevision)
        finalRevision += 1
      }

      const created = db.prepare(`
        INSERT INTO conversations (
          user_id, title, model, system_prompt,
          temperature, top_k, top_p, reasoning_effort
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        userId,
        continuationTitle(fresh.conversation.title),
        fresh.conversation.model,
        fresh.conversation.system_prompt,
        fresh.conversation.temperature,
        fresh.conversation.top_k,
        fresh.conversation.top_p,
        fresh.conversation.reasoning_effort
      )
      const targetId = Number(created.lastInsertRowid)

      hooks.afterTargetInsert?.({ targetId, sourceId, userId })

      db.prepare(`
        INSERT INTO messages (conversation_id, role, content)
        VALUES (?, 'user', ?)
      `).run(
        targetId,
        buildContinuationMessage(fresh.snapshot, text)
      )

      db.prepare(`
        UPDATE conversation_summaries
        SET
          continued_conversation_id = ?,
          continued_revision = ?,
          continue_request_id = ?,
          continue_content_hash = ?,
          updated_at = unixepoch()
        WHERE id = ?
      `).run(
        targetId,
        finalRevision,
        idempotencyKey,
        contentHash,
        stored.id
      )

      return {
        conversation: ownedConversation(db, userId, targetId),
        summary: rowToSummary(summaryRow(db, userId, sourceId)),
        restored: false
      }
    })

    return transaction()
  }

  return {
    getState: currentSummaryState,
    generate,
    cancel,
    save,
    continueFromSummary,
    activeGenerationCount: () => activeGenerations.size
  }
}
