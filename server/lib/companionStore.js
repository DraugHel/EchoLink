// Speicher fuer Luna als Companion: Einstellungen, Tagesstand, Protokoll
// und der eigene Chat "Luna". Alle Funktionen bekommen die Datenbank
// uebergeben (testbar, kein Import von db.js).
import {
  HARD_MAX_PER_DAY,
  isValidTimeZone,
  parseClock
} from './companionPlan.js'

export const COMPANION_SOURCES = [
  'memory',
  'shifts',
  'calendar',
  'mail',
  'server'
]

export const COMPANION_DEFAULT_TONE =
  'Kurz, trocken, freundlich. Wie ein Freund, der sich einfach meldet. ' +
  'Kein Assistenten-Sound, keine Floskeln.'

const COMPANION_CHAT_GUIDE =
  'Dies ist der Chat "Luna": Hier meldest du dich von dir aus, und er ' +
  'antwortet dir. Antworte wie ein Freund: kurz, direkt, ohne ' +
  'Assistenten-Floskeln. Alles andere im Chat funktioniert wie sonst.'

const DEFAULTS = Object.freeze({
  enabled: false,
  muted: false,
  minPerDay: 1,
  maxPerDay: 4,
  windowStart: '08:00',
  windowEnd: '22:00',
  timezone: 'Europe/Vienna',
  minGapMinutes: 60,
  maxUnanswered: 2,
  model: '',
  tone: '',
  rules: '',
  pushPreview: true
})

function apiError(message, statusCode = 400) {
  const error = new Error(message)
  error.statusCode = statusCode
  error.expose = true
  return error
}

const migratedDatabases = new WeakSet()

export function ensureCompanionSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS companion_settings (
      user_id INTEGER PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0
        CHECK(enabled IN (0, 1)),
      muted INTEGER NOT NULL DEFAULT 0
        CHECK(muted IN (0, 1)),
      min_per_day INTEGER NOT NULL DEFAULT 1
        CHECK(min_per_day BETWEEN 0 AND ${HARD_MAX_PER_DAY}),
      max_per_day INTEGER NOT NULL DEFAULT 4
        CHECK(max_per_day BETWEEN 1 AND ${HARD_MAX_PER_DAY}),
      window_start TEXT NOT NULL DEFAULT '08:00',
      window_end TEXT NOT NULL DEFAULT '22:00',
      timezone TEXT NOT NULL DEFAULT 'Europe/Vienna',
      min_gap_minutes INTEGER NOT NULL DEFAULT 60,
      max_unanswered INTEGER NOT NULL DEFAULT 2,
      model TEXT NOT NULL DEFAULT '',
      tone TEXT NOT NULL DEFAULT '',
      rules TEXT NOT NULL DEFAULT '',
      sources_json TEXT NOT NULL DEFAULT '{}',
      push_preview INTEGER NOT NULL DEFAULT 1
        CHECK(push_preview IN (0, 1)),
      conversation_id INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE,
      FOREIGN KEY (conversation_id)
        REFERENCES conversations(id)
        ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS companion_state (
      user_id INTEGER PRIMARY KEY,
      plan_date TEXT NOT NULL DEFAULT '',
      planned_json TEXT NOT NULL DEFAULT '[]',
      next_index INTEGER NOT NULL DEFAULT 0,
      sent_today INTEGER NOT NULL DEFAULT 0,
      last_sent_at INTEGER,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS companion_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      kind TEXT NOT NULL
        CHECK(kind IN (
          'planned', 'sent', 'skipped', 'missed',
          'paused', 'error', 'test'
        )),
      reason TEXT NOT NULL DEFAULT '',
      detail TEXT NOT NULL DEFAULT '',
      message_id INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_companion_events_user
      ON companion_events(user_id, id DESC);
  `)

  // Bestehende Installationen bekommen die neue Spalte nachgeruestet.
  if (!migratedDatabases.has(database)) {
    const columns = database
      .prepare(`PRAGMA table_info(companion_settings)`)
      .all()
      .map(column => column.name)

    if (!columns.includes('rules')) {
      try {
        database.exec(`
          ALTER TABLE companion_settings
          ADD COLUMN rules TEXT NOT NULL DEFAULT ''
        `)
      } catch (error) {
        // Worker und Server koennen gleichzeitig migrieren.
        if (!/duplicate column/i.test(error?.message || '')) {
          throw error
        }
      }
    }

    migratedDatabases.add(database)
  }
}

function parseSources(value) {
  let parsed = {}

  try {
    parsed = JSON.parse(value || '{}')
  } catch {
    parsed = {}
  }

  const sources = {}

  for (const key of COMPANION_SOURCES) {
    sources[key] =
      typeof parsed?.[key] === 'boolean'
        ? parsed[key]
        : true
  }

  return sources
}

function mapSettings(row) {
  return {
    enabled: Boolean(row.enabled),
    muted: Boolean(row.muted),
    minPerDay: row.min_per_day,
    maxPerDay: row.max_per_day,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    timezone: row.timezone,
    minGapMinutes: row.min_gap_minutes,
    maxUnanswered: row.max_unanswered,
    model: row.model,
    tone: row.tone,
    rules: row.rules || '',
    sources: parseSources(row.sources_json),
    pushPreview: Boolean(row.push_preview),
    conversationId: row.conversation_id || null
  }
}

export function getCompanionSettings(database, userId) {
  ensureCompanionSchema(database)

  database.prepare(`
    INSERT INTO companion_settings (user_id)
    VALUES (?)
    ON CONFLICT(user_id) DO NOTHING
  `).run(userId)

  return mapSettings(
    database.prepare(`
      SELECT * FROM companion_settings WHERE user_id = ?
    `).get(userId)
  )
}

function integerIn(value, min, max, label) {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw apiError(
      `${label} muss eine ganze Zahl von ${min} bis ${max} sein`
    )
  }

  return value
}

function booleanValue(value, label) {
  if (typeof value !== 'boolean') {
    throw apiError(`${label} muss true oder false sein`)
  }

  return value
}

function clockValue(value, label) {
  if (parseClock(value) === null) {
    throw apiError(`${label} muss HH:MM sein`)
  }

  return value
}

export function validateCompanionPatch(current, patch) {
  const next = { ...current, sources: { ...current.sources } }
  const input = patch && typeof patch === 'object' ? patch : {}

  if ('enabled' in input) {
    next.enabled = booleanValue(input.enabled, 'enabled')
  }

  if ('muted' in input) {
    next.muted = booleanValue(input.muted, 'muted')
  }

  if ('pushPreview' in input) {
    next.pushPreview = booleanValue(input.pushPreview, 'pushPreview')
  }

  if ('minPerDay' in input) {
    next.minPerDay = integerIn(
      input.minPerDay, 0, HARD_MAX_PER_DAY, 'Minimum pro Tag'
    )
  }

  if ('maxPerDay' in input) {
    next.maxPerDay = integerIn(
      input.maxPerDay, 1, HARD_MAX_PER_DAY, 'Maximum pro Tag'
    )
  }

  if (next.minPerDay > next.maxPerDay) {
    throw apiError('Das Minimum darf nicht groesser als das Maximum sein')
  }

  if ('windowStart' in input) {
    next.windowStart = clockValue(input.windowStart, 'Beginn')
  }

  if ('windowEnd' in input) {
    next.windowEnd = clockValue(input.windowEnd, 'Ende')
  }

  if (
    parseClock(next.windowEnd) - parseClock(next.windowStart) < 60
  ) {
    throw apiError(
      'Das Zeitfenster muss mindestens eine Stunde lang sein'
    )
  }

  if ('timezone' in input) {
    if (!isValidTimeZone(input.timezone)) {
      throw apiError('Ungueltige Zeitzone')
    }

    next.timezone = input.timezone
  }

  if ('minGapMinutes' in input) {
    next.minGapMinutes = integerIn(
      input.minGapMinutes, 15, 720, 'Mindestabstand'
    )
  }

  if ('maxUnanswered' in input) {
    next.maxUnanswered = integerIn(
      input.maxUnanswered, 1, 10, 'Unbeantwortete Nachrichten'
    )
  }

  if ('model' in input) {
    const model = String(input.model ?? '').trim()

    if (model.length > 200 || /[\u0000-\u001f\u007f]/.test(model)) {
      throw apiError('Ungueltiges Modell')
    }

    next.model = model
  }

  if ('tone' in input) {
    if (typeof input.tone !== 'string' || input.tone.length > 4000) {
      throw apiError('Der Ton darf hoechstens 4000 Zeichen lang sein')
    }

    next.tone = input.tone.trim()
  }

  if ('rules' in input) {
    if (
      typeof input.rules !== 'string' ||
      input.rules.length > 4000
    ) {
      throw apiError('Die Regeln duerfen hoechstens 4000 Zeichen lang sein')
    }

    next.rules = input.rules.trim()
  }

  if ('sources' in input) {
    if (!input.sources || typeof input.sources !== 'object') {
      throw apiError('sources muss ein Objekt sein')
    }

    for (const key of COMPANION_SOURCES) {
      if (key in input.sources) {
        next.sources[key] = booleanValue(
          input.sources[key],
          `Quelle ${key}`
        )
      }
    }
  }

  return next
}

export function updateCompanionSettings(database, userId, patch) {
  const current = getCompanionSettings(database, userId)
  const next = validateCompanionPatch(current, patch)

  database.prepare(`
    UPDATE companion_settings
    SET
      enabled = ?,
      muted = ?,
      min_per_day = ?,
      max_per_day = ?,
      window_start = ?,
      window_end = ?,
      timezone = ?,
      min_gap_minutes = ?,
      max_unanswered = ?,
      model = ?,
      tone = ?,
      rules = ?,
      sources_json = ?,
      push_preview = ?,
      updated_at = unixepoch()
    WHERE user_id = ?
  `).run(
    next.enabled ? 1 : 0,
    next.muted ? 1 : 0,
    next.minPerDay,
    next.maxPerDay,
    next.windowStart,
    next.windowEnd,
    next.timezone,
    next.minGapMinutes,
    next.maxUnanswered,
    next.model,
    next.tone,
    next.rules,
    JSON.stringify(next.sources),
    next.pushPreview ? 1 : 0,
    userId
  )

  return getCompanionSettings(database, userId)
}

// ----- Tagesstand -----

export function readCompanionState(database, userId) {
  ensureCompanionSchema(database)

  database.prepare(`
    INSERT INTO companion_state (user_id)
    VALUES (?)
    ON CONFLICT(user_id) DO NOTHING
  `).run(userId)

  const row = database.prepare(`
    SELECT * FROM companion_state WHERE user_id = ?
  `).get(userId)

  let planned = []

  try {
    const parsed = JSON.parse(row.planned_json || '[]')
    planned = Array.isArray(parsed)
      ? parsed.filter(Number.isFinite)
      : []
  } catch {
    planned = []
  }

  return {
    planDate: row.plan_date,
    planned,
    nextIndex: row.next_index,
    sentToday: row.sent_today,
    lastSentAt: row.last_sent_at || null
  }
}

export function saveCompanionState(database, userId, partial) {
  const current = readCompanionState(database, userId)
  const next = { ...current, ...partial }

  database.prepare(`
    UPDATE companion_state
    SET
      plan_date = ?,
      planned_json = ?,
      next_index = ?,
      sent_today = ?,
      last_sent_at = ?,
      updated_at = unixepoch()
    WHERE user_id = ?
  `).run(
    next.planDate,
    JSON.stringify(next.planned),
    next.nextIndex,
    next.sentToday,
    next.lastSentAt,
    userId
  )

  return next
}

// ----- Protokoll -----

export function logCompanionEvent(
  database,
  userId,
  { kind, reason = '', detail = '', messageId = null }
) {
  ensureCompanionSchema(database)

  const result = database.prepare(`
    INSERT INTO companion_events (
      user_id, kind, reason, detail, message_id
    )
    VALUES (?, ?, ?, ?, ?)
  `).run(
    userId,
    kind,
    String(reason).slice(0, 300),
    String(detail).slice(0, 600),
    messageId
  )

  database.prepare(`
    DELETE FROM companion_events
    WHERE user_id = ?
      AND id NOT IN (
        SELECT id FROM companion_events
        WHERE user_id = ?
        ORDER BY id DESC
        LIMIT 300
      )
  `).run(userId, userId)

  return Number(result.lastInsertRowid)
}

export function listCompanionEvents(database, userId, limit = 20) {
  ensureCompanionSchema(database)

  return database.prepare(`
    SELECT id, kind, reason, detail, message_id, created_at
    FROM companion_events
    WHERE user_id = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(userId, Math.min(Math.max(Number(limit) || 20, 1), 100))
    .map(row => ({
      id: row.id,
      kind: row.kind,
      reason: row.reason,
      detail: row.detail,
      messageId: row.message_id,
      createdAt: row.created_at
    }))
}

// Eigene Meldungen, auf die du seit deiner letzten Nachricht (in irgendeinem
// Chat) nicht reagiert hast. Manuell ausgeloeste zaehlen nicht mit.
export function countUnanswered(database, userId) {
  ensureCompanionSchema(database)

  return database.prepare(`
    SELECT COUNT(*) AS count
    FROM companion_events e
    WHERE e.user_id = ?
      AND e.kind = 'sent'
      AND e.reason <> 'manuell'
      AND e.message_id IS NOT NULL
      AND e.created_at > COALESCE((
        SELECT MAX(m.created_at)
        FROM messages m
        INNER JOIN conversations c
          ON c.id = m.conversation_id
        WHERE c.user_id = ?
          AND m.role = 'user'
      ), 0)
  `).get(userId, userId).count
}

export function lastUserMessageAt(database, userId) {
  return database.prepare(`
    SELECT MAX(m.created_at) AS at
    FROM messages m
    INNER JOIN conversations c ON c.id = m.conversation_id
    WHERE c.user_id = ? AND m.role = 'user'
  `).get(userId)?.at || null
}

// ----- Chat "Luna" -----

export function companionSystemPrompt(database, userId, settings) {
  const user = database.prepare(`
    SELECT default_system_prompt FROM users WHERE id = ?
  `).get(userId)

  const base = String(
    user?.default_system_prompt ||
    process.env.DEFAULT_SYSTEM_PROMPT ||
    ''
  ).trim()

  return [
    base,
    COMPANION_CHAT_GUIDE,
    `Ton:\n${settings.tone || COMPANION_DEFAULT_TONE}`
  ].filter(Boolean).join('\n\n')
}

function companionConversationRow(database, userId, settings) {
  if (!settings.conversationId) return null

  return database.prepare(`
    SELECT * FROM conversations WHERE id = ? AND user_id = ?
  `).get(settings.conversationId, userId) || null
}

export function ensureCompanionConversation(
  database,
  userId,
  { defaultModel = 'glm-5.1:cloud' } = {}
) {
  const settings = getCompanionSettings(database, userId)
  const existing = companionConversationRow(database, userId, settings)

  if (existing) {
    if (existing.archived_at) {
      database.prepare(`
        UPDATE conversations
        SET archived_at = NULL, updated_at = unixepoch()
        WHERE id = ? AND user_id = ?
      `).run(existing.id, userId)

      return companionConversationRow(database, userId, settings)
    }

    return existing
  }

  const template = database.prepare(`
    SELECT model, temperature, top_k, top_p, reasoning_effort
    FROM conversations
    WHERE user_id = ?
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
  `).get(userId)

  const created = database.prepare(`
    INSERT INTO conversations (
      user_id, title, model, system_prompt,
      temperature, top_k, top_p, reasoning_effort
    )
    VALUES (?, 'Luna', ?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    settings.model || template?.model || defaultModel,
    companionSystemPrompt(database, userId, settings),
    template?.temperature ?? 0.7,
    template?.top_k ?? 40,
    template?.top_p ?? 0.9,
    template?.reasoning_effort || ''
  )

  const conversationId = Number(created.lastInsertRowid)

  database.prepare(`
    UPDATE companion_settings
    SET conversation_id = ?, updated_at = unixepoch()
    WHERE user_id = ?
  `).run(conversationId, userId)

  return database.prepare(`
    SELECT * FROM conversations WHERE id = ?
  `).get(conversationId)
}

// Haelt Ton und Modell des Chats "Luna" mit den Einstellungen gleich,
// damit Antworten im selben Charakter bleiben.
export function syncCompanionConversation(database, userId) {
  const settings = getCompanionSettings(database, userId)
  const conversation = companionConversationRow(
    database,
    userId,
    settings
  )

  if (!conversation) return null

  database.prepare(`
    UPDATE conversations
    SET system_prompt = ?, updated_at = updated_at
    WHERE id = ? AND user_id = ?
  `).run(
    companionSystemPrompt(database, userId, settings),
    conversation.id,
    userId
  )

  if (settings.model) {
    database.prepare(`
      UPDATE conversations
      SET model = ?
      WHERE id = ? AND user_id = ?
    `).run(settings.model, conversation.id, userId)
  }

  return conversation.id
}

export function companionStatus(database, userId, nowSeconds) {
  const settings = getCompanionSettings(database, userId)
  const state = readCompanionState(database, userId)

  return {
    conversationId: settings.conversationId,
    planDate: state.planDate,
    planned: state.planned.map((at, index) => ({
      at,
      done: index < state.nextIndex
    })),
    sentToday: state.sentToday,
    lastSentAt: state.lastSentAt,
    unanswered: countUnanswered(database, userId),
    nowSeconds: Math.floor(nowSeconds)
  }
}

// ----- Tagesplan neu wuerfeln -----

const PLAN_KEYS = [
  'minPerDay',
  'maxPerDay',
  'windowStart',
  'windowEnd',
  'minGapMinutes',
  'timezone'
]

// Wann der heutige Plan nicht mehr passt und neu gewuerfelt werden soll:
// Aenderung von Haeufigkeit, Zeitfenster oder Abstand, Einschalten oder
// wieder laut schalten (sonst waere der Morgenplan voellig veraltet).
export function planNeedsReset(before, after) {
  if (PLAN_KEYS.some(key => before[key] !== after[key])) return true
  if (!before.enabled && after.enabled) return true
  if (before.muted && !after.muted) return true

  return false
}

export function resetCompanionPlan(database, userId) {
  return saveCompanionState(database, userId, {
    planDate: '',
    planned: [],
    nextIndex: 0
  })
}

// Planmaessig gesendete Meldungen seit einem Zeitpunkt (ohne manuelle).
export function countScheduledSentSince(database, userId, sinceSeconds) {
  ensureCompanionSchema(database)

  return database.prepare(`
    SELECT COUNT(*) AS count
    FROM companion_events
    WHERE user_id = ?
      AND kind = 'sent'
      AND reason <> 'manuell'
      AND created_at >= ?
  `).get(userId, sinceSeconds).count
}
