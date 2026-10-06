// Luna als Companion: meldet sich von sich aus.
//
// Ablauf: Tagesplan (Zufallszeiten im Zeitfenster) -> zur geplanten Zeit
// Kontext sammeln -> Modell schreibt eine kurze Nachricht ->
// Nachricht in den Chat "Luna" + Push. Kein Werkzeugzugriff fuer das Modell.
import {
  buildCompanionContext,
  cleanLine
} from './companionContext.js'
import {
  buildDailyPlan,
  localDateString,
  nextSlotState,
  zonedTimeToEpoch
} from './companionPlan.js'
import {
  COMPANION_INSTRUCTIONS,
  companionGenerationPrompt
} from './companionPrompt.js'
import {
  countScheduledSentSince,
  countUnanswered,
  ensureCompanionConversation,
  ensureCompanionSchema,
  getCompanionSettings,
  lastUserMessageAt,
  logCompanionEvent,
  readCompanionState,
  saveCompanionState
} from './companionStore.js'

const MAX_MESSAGE_CHARS = 500
const GENERATION_TIMEOUT_MS = 90_000

// Der System-Prompt liegt in companionPrompt.js (Regeln im Panel aenderbar).
export { companionGenerationPrompt }

export function sanitizeCompanionMessage(raw) {
  let text = String(raw ?? '').replace(/\r/g, '').trim()

  if (!text || /^skip\b/i.test(text)) {
    return { skip: true, text: '' }
  }

  text = text
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/www\.\S+/gi, '')
    .replace(/^#+\s*/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/`/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  if (text.length > MAX_MESSAGE_CHARS) {
    text = text.slice(0, MAX_MESSAGE_CHARS - 1).trimEnd() + '…'
  }

  return text.length < 2
    ? { skip: true, text: '' }
    : { skip: false, text }
}

function resolveModel(database, userId, settings, defaultModel) {
  if (settings.model) return settings.model

  const latest = database.prepare(`
    SELECT model FROM conversations
    WHERE user_id = ?
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
  `).get(userId)

  return latest?.model || defaultModel
}

function recentCompanionMessages(database, userId) {
  return database.prepare(`
    SELECT m.content
    FROM companion_events e
    INNER JOIN messages m ON m.id = e.message_id
    WHERE e.user_id = ? AND e.kind = 'sent'
    ORDER BY e.id DESC
    LIMIT 3
  `).all(userId).map(row => row.content)
}

export async function generateCompanionMessage({
  database,
  userId,
  settings,
  deps,
  nowMs,
  rng = Math.random,
  purpose = 'companion'
}) {
  const state = readCompanionState(database, userId)
  const context = await buildCompanionContext({
    userId,
    settings,
    nowMs,
    sources: deps.sources,
    rng,
    recentMessages: recentCompanionMessages(database, userId),
    lastUserAtSeconds: lastUserMessageAt(database, userId),
    lastSentAtSeconds: state.lastSentAt,
    sentToday: state.sentToday
  })

  const model = resolveModel(
    database,
    userId,
    settings,
    deps.defaultModel
  )

  // Luna meldet sich immer (siehe companionPrompt.js): Kommt trotzdem eine
  // leere Antwort oder SKIP, wird genau einmal strenger nachgefragt.
  const systemPrompt = companionGenerationPrompt(settings)

  let cleaned = { skip: true, text: '' }

  for (const instruction of COMPANION_INSTRUCTIONS) {
    const result = await deps.complete({
      model,
      messages: [
        {
          role: 'system',
          content: systemPrompt
        },
        {
          role: 'user',
          content: `${context.text}\n\n${instruction}`
        }
      ],
      options: { maxTokens: 600, reasoningEffort: 'off' },
      signal: AbortSignal.timeout(GENERATION_TIMEOUT_MS)
    })

    try {
      deps.recordUsage(database, {
        userId,
        conversationId: settings.conversationId,
        purpose,
        model,
        usage: result?.tokenUsage
      })
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error',
        event: 'companion_usage_record_failed',
        error: cleanLine(error?.message || String(error), 200)
      }))
    }

    cleaned = sanitizeCompanionMessage(result?.fullContent)

    if (!cleaned.skip) break
  }

  return {
    skipped: cleaned.skip,
    reason: cleaned.skip ? 'Luna hatte nichts zu sagen' : '',
    text: cleaned.text,
    context,
    systemPrompt,
    model
  }
}

async function deliverCompanionMessage({
  database,
  userId,
  settings,
  text,
  deps,
  manual
}) {
  const conversation = ensureCompanionConversation(
    database,
    userId,
    { defaultModel: deps.defaultModel }
  )

  const inserted = database.prepare(`
    INSERT INTO messages (conversation_id, role, content)
    VALUES (?, 'assistant', ?)
  `).run(conversation.id, text)

  database.prepare(`
    UPDATE conversations
    SET updated_at = unixepoch()
    WHERE id = ?
  `).run(conversation.id)

  const messageId = Number(inserted.lastInsertRowid)

  logCompanionEvent(database, userId, {
    kind: 'sent',
    reason: manual ? 'manuell' : '',
    detail: cleanLine(text, 120),
    messageId
  })

  const state = readCompanionState(database, userId)

  saveCompanionState(database, userId, {
    sentToday: manual ? state.sentToday : state.sentToday + 1,
    lastSentAt: Math.floor(Date.now() / 1000)
  })

  let pushResult = null

  try {
    pushResult = await deps.push(userId, {
      title: 'Luna',
      body: settings.pushPreview
        ? cleanLine(text, 160)
        : 'Luna hat dir geschrieben',
      url: `/?conversation=${conversation.id}`,
      tag: `echolink-companion-${messageId}`,
      conversationId: conversation.id
    })
  } catch (error) {
    logCompanionEvent(database, userId, {
      kind: 'error',
      reason: 'Push fehlgeschlagen',
      detail: cleanLine(error?.message || String(error), 200)
    })
  }

  return {
    messageId,
    conversationId: conversation.id,
    push: pushResult
  }
}

// Erstellt den Tagesplan, falls fuer heute noch keiner existiert und Luna
// gerade aktiv sein darf. Wird vom Worker-Takt und beim Neuwuerfeln benutzt.
export function ensureTodayPlan({
  database,
  userId,
  settings,
  nowMs,
  rng = Math.random
}) {
  const nowSeconds = Math.floor(nowMs / 1000)
  const timeZone = settings.timezone
  const today = localDateString(nowSeconds, timeZone)
  const windowStart = zonedTimeToEpoch(
    today,
    settings.windowStart,
    timeZone
  )
  const windowEnd = zonedTimeToEpoch(
    today,
    settings.windowEnd,
    timeZone
  )
  const state = readCompanionState(database, userId)
  const inWindow = nowSeconds >= windowStart && nowSeconds <= windowEnd

  if (
    !settings.enabled ||
    settings.muted ||
    !inWindow ||
    state.planDate === today
  ) {
    return { state, created: false, inWindow, nowSeconds }
  }

  const alreadySent = countScheduledSentSince(
    database,
    userId,
    zonedTimeToEpoch(today, '00:00', timeZone)
  )

  const plan = buildDailyPlan({
    dateString: today,
    timeZone,
    windowStart: settings.windowStart,
    windowEnd: settings.windowEnd,
    minPerDay: settings.minPerDay,
    maxPerDay: settings.maxPerDay,
    minGapMinutes: settings.minGapMinutes,
    nowSeconds,
    alreadySent,
    rng
  })

  const next = saveCompanionState(database, userId, {
    planDate: today,
    planned: plan.times,
    nextIndex: 0,
    sentToday: alreadySent
  })

  logCompanionEvent(database, userId, {
    kind: 'planned',
    reason:
      `${plan.count} Meldung(en) fuer den Rest des Tages geplant` +
      (alreadySent > 0 ? ` (${alreadySent} schon gesendet)` : '')
  })

  return { state: next, created: true, inWindow, nowSeconds }
}

async function runForUser({ database, userId, deps, nowMs, rng }) {
  const settings = getCompanionSettings(database, userId)

  if (!settings.enabled || settings.muted) {
    return { sent: 0, skipped: 0 }
  }

  const planned = ensureTodayPlan({
    database,
    userId,
    settings,
    nowMs,
    rng
  })

  // Ausserhalb des Zeitfensters passiert nichts.
  if (!planned.inWindow) {
    return { sent: 0, skipped: 0 }
  }

  const nowSeconds = planned.nowSeconds
  const state = planned.state

  const slot = nextSlotState({
    times: state.planned,
    nextIndex: state.nextIndex,
    nowSeconds
  })

  if (slot.missed > 0) {
    logCompanionEvent(database, userId, {
      kind: 'missed',
      reason: `${slot.missed} geplante Meldung(en) verpasst`
    })
  }

  if (!slot.due) {
    if (slot.nextIndex !== state.nextIndex) {
      saveCompanionState(database, userId, {
        nextIndex: slot.nextIndex
      })
    }

    return { sent: 0, skipped: 0 }
  }

  // Der Slot gilt ab jetzt als verbraucht, auch wenn danach etwas schiefgeht
  // (lieber eine Meldung zu wenig als doppelt).
  saveCompanionState(database, userId, {
    nextIndex: slot.nextIndex + 1
  })

  const unanswered = countUnanswered(database, userId)

  if (unanswered >= settings.maxUnanswered) {
    logCompanionEvent(database, userId, {
      kind: 'paused',
      reason: `${unanswered} Meldung(en) unbeantwortet, Luna wartet`
    })

    return { sent: 0, skipped: 1 }
  }

  const generated = await generateCompanionMessage({
    database,
    userId,
    settings,
    deps,
    nowMs,
    rng
  })

  if (generated.skipped) {
    logCompanionEvent(database, userId, {
      kind: 'skipped',
      reason: generated.reason,
      detail: generated.model
    })

    return { sent: 0, skipped: 1 }
  }

  await deliverCompanionMessage({
    database,
    userId,
    settings,
    text: generated.text,
    deps,
    manual: false
  })

  return { sent: 1, skipped: 0 }
}

// Billige Vorpruefung fuer den Worker: ohne aktivierte Benutzer werden
// weder Provider noch Google-Module geladen.
export function companionHasActiveUsers(database) {
  ensureCompanionSchema(database)

  return database.prepare(`
    SELECT COUNT(*) AS count
    FROM companion_settings
    WHERE enabled = 1
  `).get().count > 0
}

export async function runCompanionCycle({
  database,
  deps,
  nowMs = Date.now(),
  rng = Math.random
}) {
  ensureCompanionSchema(database)

  const users = database.prepare(`
    SELECT user_id FROM companion_settings WHERE enabled = 1
  `).all()

  let sent = 0
  let skipped = 0

  for (const { user_id: userId } of users) {
    try {
      const result = await runForUser({
        database,
        userId,
        deps,
        nowMs,
        rng
      })

      sent += result.sent
      skipped += result.skipped
    } catch (error) {
      const message = cleanLine(error?.message || String(error), 200)

      try {
        logCompanionEvent(database, userId, {
          kind: 'error',
          reason: 'Zyklus fehlgeschlagen',
          detail: message
        })
      } catch {}

      console.error(JSON.stringify({
        level: 'error',
        event: 'companion_cycle_failed',
        userId,
        error: message
      }))
    }
  }

  return { users: users.length, sent, skipped }
}

// Vorschau: zeigt, was Luna sehen wuerde und was sie schreiben wuerde.
// Es wird nichts gesendet oder gespeichert (ausser Protokoll und Kosten).
export async function previewCompanion({
  database,
  userId,
  deps,
  nowMs = Date.now(),
  rng = Math.random
}) {
  const settings = getCompanionSettings(database, userId)
  const generated = await generateCompanionMessage({
    database,
    userId,
    settings,
    deps,
    nowMs,
    rng,
    purpose: 'companion_preview'
  })

  logCompanionEvent(database, userId, {
    kind: 'test',
    reason: generated.skipped
      ? 'Vorschau: Luna wuerde schweigen'
      : 'Vorschau erzeugt',
    detail: generated.model
  })

  return {
    context: generated.context.text,
    sections: generated.context.sections,
    message: generated.text,
    skipped: generated.skipped,
    systemPrompt: generated.systemPrompt,
    model: generated.model
  }
}

// Sendet sofort eine Nachricht, unabhaengig vom Tagesplan. Zaehlt nicht
// zum Tageslimit. Stumm bleibt stumm.
export async function sendCompanionNow({
  database,
  userId,
  deps,
  nowMs = Date.now(),
  rng = Math.random
}) {
  const settings = getCompanionSettings(database, userId)

  if (settings.muted) {
    const error = new Error('Luna ist stumm geschaltet')
    error.statusCode = 409
    error.expose = true
    throw error
  }

  const generated = await generateCompanionMessage({
    database,
    userId,
    settings,
    deps,
    nowMs,
    rng
  })

  if (generated.skipped) {
    logCompanionEvent(database, userId, {
      kind: 'skipped',
      reason: `${generated.reason} (manuell)`,
      detail: generated.model
    })

    return { sent: false, skipped: true, reason: generated.reason }
  }

  const delivered = await deliverCompanionMessage({
    database,
    userId,
    settings,
    text: generated.text,
    deps,
    manual: true
  })

  return {
    sent: true,
    skipped: false,
    message: generated.text,
    conversationId: delivered.conversationId
  }
}

// ----- Datenquellen -----

// Kommende Schichten aus den importierten und synchronisierten Plaenen.
export function listUpcomingShifts(
  database,
  userId,
  fromDate,
  toDate
) {
  const rows = database.prepare(`
    SELECT
      i.work_date, i.code, i.start_time, i.end_time, i.title
    FROM shift_import_items i
    INNER JOIN shift_imports s ON s.id = i.import_id
    WHERE s.user_id = ?
      AND s.archived_at IS NULL
      AND i.import_status IN ('created', 'duplicate')
      AND i.work_date >= ?
      AND i.work_date <= ?
    ORDER BY i.work_date ASC, i.start_time ASC
    LIMIT 40
  `).all(userId, fromDate, toDate)

  const seen = new Set()
  const result = []

  for (const row of rows) {
    const key = `${row.work_date}|${row.start_time}`

    if (seen.has(key)) continue

    seen.add(key)
    result.push({
      workDate: row.work_date,
      code: row.code,
      startTime: row.start_time,
      endTime: row.end_time,
      title: row.title
    })
  }

  return result
}

export async function defaultCompanionDeps(database) {
  const dbModule = await import('../db.js')
  const db = database || dbModule.default

  const [
    providers,
    push,
    usage,
    memory,
    calendar,
    gmail,
    watchtower,
    fs
  ] = await Promise.all([
    import('../providers/index.js'),
    import('./push.js'),
    import('./modelUsageLedger.js'),
    import('./memoryItems.js'),
    import('../connectors/google/calendar.js'),
    import('../connectors/google/gmail.js'),
    import('./watchtower.js'),
    import('node:fs/promises')
  ])

  return {
    defaultModel: dbModule.DEFAULT_MODEL,
    complete: providers.completeWithProvider,
    push: push.sendPushToUser,
    recordUsage: usage.recordModelUsageEvent,
    sources: {
      memory: async userId =>
        memory.listMemoryItems(userId, {
          status: 'active',
          limit: 80
        }),
      shifts: async (userId, { fromDate, toDate }) =>
        listUpcomingShifts(db, userId, fromDate, toDate),
      calendar: async (userId, { timeMin, timeMax, timeZone }) =>
        (await calendar.listCalendarEvents(userId, {
          timeMin,
          timeMax,
          timeZone,
          maxResults: 10
        })).events,
      mail: async userId => {
        const result = await gmail.searchGmailMessages(userId, {
          query: 'is:unread in:inbox',
          maxResults: 5
        })

        return {
          messages: result.messages,
          total: result.resultSizeEstimate || result.count
        }
      },
      server: async userId => {
        const stats = await fs.statfs('/')
        const total = Number(stats.blocks) * Number(stats.bsize)
        const free = Number(stats.bavail) * Number(stats.bsize)

        return {
          diskPercent: total > 0
            ? Math.round((total - free) / total * 100)
            : null,
          incidents: watchtower.getWatchtowerStatus(db, userId).incidents
        }
      }
    }
  }
}
