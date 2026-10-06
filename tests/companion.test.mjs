import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

import {
  companionGenerationPrompt,
  companionHasActiveUsers,
  listUpcomingShifts,
  previewCompanion,
  runCompanionCycle,
  sanitizeCompanionMessage,
  sendCompanionNow
} from '../server/lib/companion.js'
import { zonedTimeToEpoch } from '../server/lib/companionPlan.js'
import {
  companionStatus,
  countUnanswered,
  ensureCompanionConversation,
  getCompanionSettings,
  listCompanionEvents,
  readCompanionState,
  syncCompanionConversation,
  updateCompanionSettings
} from '../server/lib/companionStore.js'

const ZONE = 'Europe/Vienna'
const DAY = '2026-10-06'

function seeded(seed) {
  let state = seed >>> 0

  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function at(clock, day = DAY) {
  return zonedTimeToEpoch(day, clock, ZONE) * 1000
}

function makeDatabase() {
  const database = new Database(':memory:')

  database.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT,
      password_hash TEXT DEFAULT '',
      default_system_prompt TEXT DEFAULT ''
    );
    CREATE TABLE conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT 'New Conversation',
      model TEXT NOT NULL DEFAULT 'llama3',
      system_prompt TEXT DEFAULT '',
      temperature REAL DEFAULT 0.7,
      top_k INTEGER DEFAULT 40,
      top_p REAL DEFAULT 0.9,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch()),
      archived_at INTEGER,
      reasoning_effort TEXT DEFAULT ''
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE shift_imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      archived_at INTEGER
    );
    CREATE TABLE shift_import_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_id INTEGER NOT NULL,
      work_date TEXT NOT NULL,
      code TEXT DEFAULT '',
      start_time TEXT DEFAULT '',
      end_time TEXT DEFAULT '',
      title TEXT DEFAULT '',
      import_status TEXT DEFAULT 'pending'
    );
    INSERT INTO users (username) VALUES ('draug');
  `)

  return database
}

function makeDeps(options = {}) {
  const calls = { complete: [], push: [], usage: [] }
  let replyIndex = 0

  return {
    calls,
    defaultModel: 'test-model',
    complete: async args => {
      calls.complete.push(args)

      if (options.completeError) throw options.completeError

      const reply = Array.isArray(options.replies)
        ? options.replies[Math.min(replyIndex++, options.replies.length - 1)]
        : options.reply ?? 'Na, wie war die Schicht?'

      return {
        fullContent: reply,
        tokenUsage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 }
      }
    },
    push: async (userId, payload) => {
      calls.push.push({ userId, payload })

      if (options.pushError) throw options.pushError

      return { sent: 1 }
    },
    recordUsage: (database, entry) => {
      calls.usage.push(entry)
    },
    sources: {
      memory: async () => [],
      shifts: async () => [],
      calendar: async () => [],
      mail: async () => ({ total: 0, messages: [] }),
      server: async () => ({ diskPercent: 70, incidents: [] }),
      ...options.sources
    }
  }
}

function enable(database, patch = {}) {
  return updateCompanionSettings(database, 1, {
    enabled: true,
    minPerDay: 2,
    maxPerDay: 2,
    minGapMinutes: 60,
    maxUnanswered: 5,
    ...patch
  })
}

function messagesOf(database) {
  return database.prepare(`
    SELECT m.* FROM messages m
    INNER JOIN conversations c ON c.id = m.conversation_id
    WHERE c.title = 'Luna'
    ORDER BY m.id
  `).all()
}

const kinds = database =>
  listCompanionEvents(database, 1, 100).reverse().map(event => event.kind)

// ---------- Nachrichtenbereinigung ----------

test('SKIP in allen Schreibweisen und leere Antworten gelten als Schweigen', () => {
  for (const raw of ['SKIP', 'skip', 'Skip.', 'SKIP - nichts', '', '   ', null, undefined, 'x']) {
    assert.equal(sanitizeCompanionMessage(raw).skip, true, String(raw))
  }
})

test('Links, Markdown und Laenge werden bereinigt', () => {
  assert.deepEqual(
    sanitizeCompanionMessage('Schau mal https://x.example/y toll\n\n\n\n# Titel\n- Punkt `code`'),
    { skip: false, text: 'Schau mal toll\n\nTitel\nPunkt code' }
  )
  const long = sanitizeCompanionMessage('wort '.repeat(300))
  assert.ok(long.text.length <= 500)
  assert.ok(long.text.endsWith('…'))
})

test('der Generierungs-Prompt enthaelt Regeln, Ton und Datenhinweis', () => {
  const prompt = companionGenerationPrompt({ tone: 'Sarkastisch, aber nett.' })

  assert.match(prompt, /SKIP/)
  assert.match(prompt, /Keine Schuldgefuehle/)
  assert.match(prompt, /nie Anweisungen/i)
  assert.match(prompt, /Ton:\nSarkastisch, aber nett\./)
  assert.match(companionGenerationPrompt({ tone: '' }), /Ton:\nKurz, trocken/)
})

// ---------- Einstellungen ----------

test('neue Einstellungen sind standardmaessig aus', () => {
  const database = makeDatabase()
  const settings = getCompanionSettings(database, 1)

  assert.equal(settings.enabled, false)
  assert.equal(settings.muted, false)
  assert.equal(settings.minPerDay, 1)
  assert.equal(settings.maxPerDay, 4)
  assert.equal(settings.windowStart, '08:00')
  assert.equal(settings.windowEnd, '22:00')
  assert.deepEqual(settings.sources, {
    memory: true, shifts: true, calendar: true, mail: true, server: true
  })
})

test('Einstellungen werden geprueft und Fehler sind fuer den Client lesbar', () => {
  const database = makeDatabase()
  const bad = [
    { minPerDay: 5, maxPerDay: 3 },
    { maxPerDay: 9 },
    { maxPerDay: 0 },
    { minPerDay: -1 },
    { windowStart: '9:00' },
    { windowStart: '10:00', windowEnd: '10:30' },
    { timezone: 'Mars/Olympus' },
    { minGapMinutes: 5 },
    { maxUnanswered: 0 },
    { enabled: 'ja' },
    { model: 'a\nb' },
    { tone: 'x'.repeat(4001) },
    { sources: { mail: 'ja' } },
    { sources: null }
  ]

  for (const patch of bad) {
    assert.throws(
      () => updateCompanionSettings(database, 1, patch),
      error => error.statusCode === 400 && error.expose === true,
      JSON.stringify(patch)
    )
  }

  // Nichts davon wurde gespeichert.
  assert.equal(getCompanionSettings(database, 1).maxPerDay, 4)
})

test('Teil-Aenderungen behalten den Rest, unbekannte Felder werden ignoriert', () => {
  const database = makeDatabase()

  updateCompanionSettings(database, 1, {
    muted: true,
    unbekannt: 1,
    sources: { mail: false },
    tone: '  frech  '
  })

  const settings = getCompanionSettings(database, 1)

  assert.equal(settings.muted, true)
  assert.equal(settings.tone, 'frech')
  assert.equal(settings.sources.mail, false)
  assert.equal(settings.sources.memory, true)
  assert.equal(settings.maxPerDay, 4)
})

// ---------- Tageszyklus ----------

test('aus oder stumm: kein Plan, keine Nachricht', async () => {
  const database = makeDatabase()
  const deps = makeDeps()

  await runCompanionCycle({ database, deps, nowMs: at('12:00'), rng: seeded(1) })
  assert.equal(readCompanionState(database, 1).planDate, '')

  enable(database, { muted: true })
  await runCompanionCycle({ database, deps, nowMs: at('12:00'), rng: seeded(1) })
  assert.equal(readCompanionState(database, 1).planDate, '')
  assert.equal(deps.calls.complete.length, 0)
})

test('ausserhalb des Zeitfensters passiert nichts', async () => {
  const database = makeDatabase()
  const deps = makeDeps()

  enable(database)

  for (const clock of ['07:00', '22:30', '03:00']) {
    await runCompanionCycle({ database, deps, nowMs: at(clock), rng: seeded(1) })
  }

  assert.equal(readCompanionState(database, 1).planDate, '')
  assert.equal(deps.calls.complete.length, 0)
})

test('erster Tick plant, zur geplanten Zeit wird gesendet', async () => {
  const database = makeDatabase()
  const deps = makeDeps({ reply: 'Na, wie war die Schicht?' })

  enable(database)

  await runCompanionCycle({ database, deps, nowMs: at('09:00'), rng: seeded(3) })

  const planned = readCompanionState(database, 1).planned

  assert.equal(readCompanionState(database, 1).planDate, DAY)
  assert.equal(planned.length, 2)
  assert.equal(deps.calls.complete.length, 0, 'noch nicht faellig')
  assert.equal(messagesOf(database).length, 0)

  const result = await runCompanionCycle({
    database,
    deps,
    nowMs: planned[0] * 1000,
    rng: seeded(3)
  })

  assert.deepEqual(result, { users: 1, sent: 1, skipped: 0 })

  const [message] = messagesOf(database)

  assert.equal(message.role, 'assistant')
  assert.equal(message.content, 'Na, wie war die Schicht?')

  const conversation = database.prepare(`SELECT * FROM conversations WHERE title = 'Luna'`).get()

  assert.equal(conversation.model, 'test-model')
  assert.equal(getCompanionSettings(database, 1).conversationId, conversation.id)

  // Push
  assert.equal(deps.calls.push.length, 1)
  assert.equal(deps.calls.push[0].userId, 1)
  assert.equal(deps.calls.push[0].payload.title, 'Luna')
  assert.equal(deps.calls.push[0].payload.body, 'Na, wie war die Schicht?')
  assert.equal(deps.calls.push[0].payload.url, `/?conversation=${conversation.id}`)
  assert.equal(deps.calls.push[0].payload.conversationId, conversation.id)

  // Modellaufruf: ohne Werkzeuge, kurz, mit Kontext als Daten
  const call = deps.calls.complete[0]

  assert.equal(call.model, 'test-model')
  assert.equal(call.options.maxTokens, 600)
  assert.equal(call.options.reasoningEffort, 'off')
  assert.equal(call.messages[0].role, 'system')
  assert.match(call.messages[1].content, /^=== KONTEXT/)
  assert.match(call.messages[1].content, /oder antworte exakt SKIP\.$/)

  // Kosten werden erfasst
  assert.equal(deps.calls.usage.length, 1)
  assert.equal(deps.calls.usage[0].purpose, 'companion')
  assert.equal(deps.calls.usage[0].usage.totalTokens, 110)

  // Stand und Protokoll
  assert.equal(readCompanionState(database, 1).sentToday, 1)
  assert.deepEqual(kinds(database), ['planned', 'sent'])
})

test('ein Slot wird nur einmal verbraucht', async () => {
  const database = makeDatabase()
  const deps = makeDeps()

  enable(database)
  await runCompanionCycle({ database, deps, nowMs: at('09:00'), rng: seeded(3) })

  const first = readCompanionState(database, 1).planned[0] * 1000

  await runCompanionCycle({ database, deps, nowMs: first, rng: seeded(3) })
  await runCompanionCycle({ database, deps, nowMs: first + 1000, rng: seeded(3) })
  await runCompanionCycle({ database, deps, nowMs: first + 2000, rng: seeded(3) })

  assert.equal(deps.calls.complete.length, 1)
  assert.equal(messagesOf(database).length, 1)
})

test('SKIP schreibt nichts, verbraucht aber den Slot', async () => {
  const database = makeDatabase()
  const deps = makeDeps({ reply: 'SKIP' })

  enable(database)
  await runCompanionCycle({ database, deps, nowMs: at('09:00'), rng: seeded(3) })

  const first = readCompanionState(database, 1).planned[0] * 1000
  const result = await runCompanionCycle({ database, deps, nowMs: first, rng: seeded(3) })

  assert.deepEqual(result, { users: 1, sent: 0, skipped: 1 })
  assert.equal(messagesOf(database).length, 0)
  assert.equal(deps.calls.push.length, 0)
  assert.deepEqual(kinds(database), ['planned', 'skipped'])

  await runCompanionCycle({ database, deps, nowMs: first + 5000, rng: seeded(3) })
  assert.equal(deps.calls.complete.length, 1)
})

test('verpasste Slots werden verworfen statt spaet nachgeholt', async () => {
  const database = makeDatabase()
  const deps = makeDeps()

  enable(database)
  await runCompanionCycle({ database, deps, nowMs: at('09:00'), rng: seeded(3) })

  const first = readCompanionState(database, 1).planned[0] * 1000

  await runCompanionCycle({ database, deps, nowMs: first + 46 * 60 * 1000, rng: seeded(3) })

  assert.equal(deps.calls.complete.length, 0)
  assert.ok(kinds(database).includes('missed'))
  assert.equal(readCompanionState(database, 1).nextIndex, 1)
})

test('Fehler im Modell stoppen den Zyklus nicht und werden protokolliert', async () => {
  const database = makeDatabase()
  const deps = makeDeps({ completeError: new Error('Anthropic 529: overloaded') })

  enable(database)
  await runCompanionCycle({ database, deps, nowMs: at('09:00'), rng: seeded(3) })

  const first = readCompanionState(database, 1).planned[0] * 1000
  const originalError = console.error
  console.error = () => {}

  try {
    const result = await runCompanionCycle({ database, deps, nowMs: first, rng: seeded(3) })

    assert.deepEqual(result, { users: 1, sent: 0, skipped: 0 })
  } finally {
    console.error = originalError
  }

  const errorEvent = listCompanionEvents(database, 1, 10).find(event => event.kind === 'error')

  assert.match(errorEvent.detail, /overloaded/)
  assert.equal(messagesOf(database).length, 0)

  // Kein zweiter Versuch fuer denselben Slot.
  await runCompanionCycle({ database, deps, nowMs: first + 1000, rng: seeded(3) })
  assert.equal(deps.calls.complete.length, 1)
})

test('unbeantwortete Meldungen pausieren Luna bis du schreibst', async () => {
  const database = makeDatabase()
  const deps = makeDeps()

  enable(database, { minPerDay: 3, maxPerDay: 3, minGapMinutes: 15, maxUnanswered: 1 })
  await runCompanionCycle({ database, deps, nowMs: at('09:00'), rng: seeded(5) })

  const [slot0, slot1, slot2] = readCompanionState(database, 1).planned.map(second => second * 1000)

  await runCompanionCycle({ database, deps, nowMs: slot0, rng: seeded(5) })
  assert.equal(messagesOf(database).length, 1)
  assert.equal(countUnanswered(database, 1), 1)

  await runCompanionCycle({ database, deps, nowMs: slot1, rng: seeded(5) })
  assert.equal(messagesOf(database).length, 1, 'pausiert')
  assert.ok(kinds(database).includes('paused'))

  // Du antwortest in irgendeinem Chat.
  database.prepare(`UPDATE companion_events SET created_at = 1000 WHERE kind = 'sent'`).run()
  database.prepare(`INSERT INTO conversations (user_id, title) VALUES (1, 'Server Shit')`).run()
  database.prepare(`
    INSERT INTO messages (conversation_id, role, content, created_at)
    VALUES (2, 'user', 'hey', 2000)
  `).run()

  assert.equal(countUnanswered(database, 1), 0)

  await runCompanionCycle({ database, deps, nowMs: slot2, rng: seeded(5) })
  assert.equal(messagesOf(database).length, 2, 'wieder aktiv')
})

test('Push-Vorschau kann verborgen werden', async () => {
  const database = makeDatabase()
  const deps = makeDeps({ reply: 'Geheimer Satz ueber die Mail vom Chef' })

  enable(database, { pushPreview: false })
  await runCompanionCycle({ database, deps, nowMs: at('09:00'), rng: seeded(3) })

  const first = readCompanionState(database, 1).planned[0] * 1000

  await runCompanionCycle({ database, deps, nowMs: first, rng: seeded(3) })

  assert.equal(deps.calls.push[0].payload.body, 'Luna hat dir geschrieben')
  assert.equal(messagesOf(database)[0].content, 'Geheimer Satz ueber die Mail vom Chef')
})

test('Push-Fehler gehen nicht auf Kosten der Nachricht', async () => {
  const database = makeDatabase()
  const deps = makeDeps({ pushError: new Error('410 Gone') })

  enable(database)
  await runCompanionCycle({ database, deps, nowMs: at('09:00'), rng: seeded(3) })

  const first = readCompanionState(database, 1).planned[0] * 1000
  const result = await runCompanionCycle({ database, deps, nowMs: first, rng: seeded(3) })

  assert.equal(result.sent, 1)
  assert.equal(messagesOf(database).length, 1)
  assert.ok(
    listCompanionEvents(database, 1, 10).some(
      event => event.kind === 'error' && /Push/.test(event.reason)
    )
  )
})

test('faellt eine Quelle aus, schreibt Luna trotzdem', async () => {
  const database = makeDatabase()
  const deps = makeDeps({
    sources: { mail: async () => { throw new Error('Google nicht verbunden') } }
  })

  enable(database)
  await runCompanionCycle({ database, deps, nowMs: at('09:00'), rng: seeded(3) })

  const first = readCompanionState(database, 1).planned[0] * 1000

  await runCompanionCycle({ database, deps, nowMs: first, rng: seeded(3) })

  assert.equal(messagesOf(database).length, 1)
  assert.match(deps.calls.complete[0].messages[1].content, /\[Mail\] derzeit nicht verfuegbar/)
})

test('das eingestellte Modell hat Vorrang vor dem Standard', async () => {
  const database = makeDatabase()
  const deps = makeDeps()

  enable(database, { model: 'openai/gpt-5.6-luna' })
  await runCompanionCycle({ database, deps, nowMs: at('09:00'), rng: seeded(3) })

  const first = readCompanionState(database, 1).planned[0] * 1000

  await runCompanionCycle({ database, deps, nowMs: first, rng: seeded(3) })

  assert.equal(deps.calls.complete[0].model, 'openai/gpt-5.6-luna')
  assert.equal(deps.calls.usage[0].model, 'openai/gpt-5.6-luna')
})

// ---------- Vorschau und Jetzt senden ----------

test('Vorschau schreibt keine Nachricht und sendet keinen Push', async () => {
  const database = makeDatabase()
  const deps = makeDeps({ reply: 'Vorschau-Satz' })

  const preview = await previewCompanion({ database, userId: 1, deps, nowMs: at('12:00'), rng: seeded(1) })

  assert.equal(preview.message, 'Vorschau-Satz')
  assert.equal(preview.skipped, false)
  assert.match(preview.context, /\[Server\]/)
  assert.equal(preview.sections.find(section => section.label === 'Mail').lines, 1)
  assert.equal(messagesOf(database).length, 0)
  assert.equal(deps.calls.push.length, 0)
  assert.equal(deps.calls.usage[0].purpose, 'companion_preview')
  assert.deepEqual(kinds(database), ['test'])

  const skipped = await previewCompanion({
    database,
    userId: 1,
    deps: makeDeps({ reply: 'SKIP' }),
    nowMs: at('12:00'),
    rng: seeded(1)
  })

  assert.equal(skipped.skipped, true)
  assert.equal(skipped.message, '')
})

test('Jetzt senden gilt auch ausserhalb des Fensters, zaehlt aber nicht mit', async () => {
  const database = makeDatabase()
  const deps = makeDeps({ reply: 'Test-Nachricht' })

  const result = await sendCompanionNow({ database, userId: 1, deps, nowMs: at('03:00'), rng: seeded(1) })

  assert.equal(result.sent, true)
  assert.equal(result.message, 'Test-Nachricht')
  assert.equal(messagesOf(database).length, 1)
  assert.equal(deps.calls.push.length, 1)
  assert.equal(readCompanionState(database, 1).sentToday, 0)
  assert.equal(countUnanswered(database, 1), 0)
  assert.equal(listCompanionEvents(database, 1, 1)[0].reason, 'manuell')
})

test('stumm bleibt stumm, auch bei Jetzt senden', async () => {
  const database = makeDatabase()
  const deps = makeDeps()

  updateCompanionSettings(database, 1, { muted: true })

  await assert.rejects(
    sendCompanionNow({ database, userId: 1, deps, nowMs: at('12:00'), rng: seeded(1) }),
    error => error.statusCode === 409 && error.expose === true
  )
  assert.equal(deps.calls.complete.length, 0)
})

// ---------- Chat "Luna" ----------

test('der Chat "Luna" entsteht einmal und folgt Ton und Modell', () => {
  const database = makeDatabase()

  database.prepare(`UPDATE users SET default_system_prompt = 'Basis-Prompt' WHERE id = 1`).run()
  database.prepare(`
    INSERT INTO conversations (user_id, title, model, temperature, reasoning_effort)
    VALUES (1, 'Alt', 'claude-sonnet-5-5', 0.3, 'medium')
  `).run()
  updateCompanionSettings(database, 1, { tone: 'Trocken wie Toast.' })

  const created = ensureCompanionConversation(database, 1, { defaultModel: 'x' })

  assert.equal(created.title, 'Luna')
  assert.equal(created.model, 'claude-sonnet-5-5')
  assert.equal(created.reasoning_effort, 'medium')
  assert.match(created.system_prompt, /^Basis-Prompt/)
  assert.match(created.system_prompt, /Trocken wie Toast\./)

  const again = ensureCompanionConversation(database, 1, { defaultModel: 'x' })

  assert.equal(again.id, created.id)
  assert.equal(
    database.prepare(`SELECT COUNT(*) AS n FROM conversations WHERE title = 'Luna'`).get().n,
    1
  )

  updateCompanionSettings(database, 1, { tone: 'Jetzt freundlich.', model: 'openai/gpt-5.6-luna' })
  syncCompanionConversation(database, 1)

  const synced = database.prepare(`SELECT * FROM conversations WHERE id = ?`).get(created.id)

  assert.match(synced.system_prompt, /Jetzt freundlich\./)
  assert.ok(!synced.system_prompt.includes('Trocken wie Toast'))
  assert.equal(synced.model, 'openai/gpt-5.6-luna')

  database.prepare(`UPDATE conversations SET archived_at = 5 WHERE id = ?`).run(created.id)
  assert.equal(ensureCompanionConversation(database, 1, {}).archived_at, null)
})

test('der Status zeigt Plan, erledigte Slots und unbeantwortete Meldungen', async () => {
  const database = makeDatabase()
  const deps = makeDeps()

  enable(database)
  await runCompanionCycle({ database, deps, nowMs: at('09:00'), rng: seeded(3) })

  const first = readCompanionState(database, 1).planned[0] * 1000

  await runCompanionCycle({ database, deps, nowMs: first, rng: seeded(3) })

  const status = companionStatus(database, 1, first / 1000)

  assert.equal(status.planDate, DAY)
  assert.equal(status.planned.length, 2)
  assert.deepEqual(status.planned.map(slot => slot.done), [true, false])
  assert.equal(status.sentToday, 1)
  assert.equal(status.unanswered, 1)
  assert.ok(status.conversationId > 0)
})

// ---------- Schichten ----------

test('kommende Schichten: nur gueltiger Status, nicht archiviert, ohne Doppelte', () => {
  const database = makeDatabase()

  database.exec(`
    INSERT INTO shift_imports (user_id, archived_at) VALUES (1, NULL), (1, 99), (2, NULL);
    INSERT INTO shift_import_items (import_id, work_date, code, start_time, end_time, title, import_status) VALUES
      (1, '2026-10-06', 'S', '14:00', '22:00', 'Spaet', 'created'),
      (1, '2026-10-07', 'F', '06:00', '14:00', 'Frueh', 'duplicate'),
      (1, '2026-10-08', 'N', '22:00', '06:00', 'Nacht', 'pending'),
      (1, '2026-10-09', 'F', '06:00', '14:00', 'Frueh', 'error'),
      (1, '2026-09-30', 'F', '06:00', '14:00', 'Vorbei', 'created'),
      (1, '2026-10-20', 'F', '06:00', '14:00', 'Zu weit', 'created'),
      (2, '2026-10-06', 'S', '14:00', '22:00', 'Archiviert', 'created'),
      (3, '2026-10-06', 'S', '14:00', '22:00', 'Fremd', 'created');
    INSERT INTO shift_import_items (import_id, work_date, code, start_time, end_time, title, import_status)
      VALUES (1, '2026-10-06', 'S', '14:00', '22:00', 'Spaet', 'duplicate');
  `)

  const rows = listUpcomingShifts(database, 1, '2026-10-06', '2026-10-13')

  assert.deepEqual(rows.map(row => `${row.workDate} ${row.title}`), [
    '2026-10-06 Spaet',
    '2026-10-07 Frueh'
  ])
})

test('der Worker prueft guenstig, ob ueberhaupt jemand aktiviert ist', () => {
  const database = makeDatabase()

  assert.equal(companionHasActiveUsers(database), false)

  updateCompanionSettings(database, 1, { muted: true })
  assert.equal(companionHasActiveUsers(database), false)

  updateCompanionSettings(database, 1, { enabled: true })
  assert.equal(companionHasActiveUsers(database), true)
})
