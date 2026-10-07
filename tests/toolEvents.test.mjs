import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'

import {
  TOOL_LOG_MARKER,
  clearToolEvents,
  ensureToolEventSchema,
  formatToolLog,
  listToolEvents,
  recordToolEvent,
  redactSecrets,
  summarizeToolArgs,
  toolResultStatus
} from '../server/lib/toolEvents.js'
import {
  TERMINAL_LOG_MARKER,
  hasTerminalLog,
  loadModelHistory
} from '../server/lib/terminalHistory.js'

function makeDatabase() {
  const database = new Database(':memory:')

  database.exec(`
    CREATE TABLE conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT DEFAULT 'x'
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      images TEXT DEFAULT '',
      source_terminal_operation_id TEXT
    );
    CREATE TABLE chat_terminal_operations (
      id TEXT PRIMARY KEY,
      command TEXT NOT NULL,
      status TEXT NOT NULL,
      result TEXT NOT NULL DEFAULT ''
    );
    INSERT INTO conversations (title) VALUES ('a'), ('b');
  `)

  return database
}

function addMessage(database, conversationId, role, content, operationId = null) {
  return Number(
    database.prepare(`
      INSERT INTO messages (conversation_id, role, content, source_terminal_operation_id)
      VALUES (?, ?, ?, ?)
    `).run(conversationId, role, content, operationId).lastInsertRowid
  )
}

const call = (name, args, id = 'call_1') => ({
  id,
  function: { name, arguments: args }
})

function record(database, toolCall, result, overrides = {}) {
  return recordToolEvent(database, {
    conversationId: 1,
    userMessageId: 1,
    requestId: 'r1',
    toolCall,
    result,
    ...overrides
  })
}

test('das Schema entsteht einmal und ist wiederholbar', () => {
  const database = makeDatabase()

  ensureToolEventSchema(database)
  ensureToolEventSchema(database)

  const columns = database
    .prepare(`PRAGMA table_info(chat_tool_events)`)
    .all()
    .map(column => column.name)

  assert.ok(['tool', 'args', 'status', 'summary', 'user_message_id'].every(name => columns.includes(name)))
})

test('Websuche: Anfrage, Ergebnisauszug, Status ok; Argumente als Text oder Objekt', () => {
  const database = makeDatabase()
  const result = '1. Claude Haiku 4.5: $1 / $5 pro Million Tokens (anthropic.com)\n2. Weitere Treffer ' + 'x'.repeat(900)

  const first = record(database, call('web_search', JSON.stringify({ query: 'Claude Haiku Preis' })), result)
  record(database, call('web_search', { query: 'GPT Preise' }, 'call_2'), 'Treffer')

  const events = listToolEvents(database, 1)

  assert.ok(first > 0)
  assert.equal(events.length, 2)
  assert.equal(events[0].tool, 'web_search')
  assert.equal(events[0].args, 'Claude Haiku Preis')
  assert.equal(events[0].status, 'ok')
  assert.ok(events[0].summary.startsWith('1. Claude Haiku 4.5: $1 / $5'))
  assert.ok(events[0].summary.length < 560, `Auszug ${events[0].summary.length}`)
  assert.equal(events[1].args, 'GPT Preise')
})

test('Terminal wird hier nicht erfasst (dafuer gibt es das Terminal-Protokoll)', () => {
  const database = makeDatabase()

  assert.equal(record(database, call('terminal', { command: 'ls' }), 'x'), null)
  assert.equal(listToolEvents(database, 1).length, 0)
})

test('private Werkzeuge: nur der Aufruf, nie das Ergebnis', () => {
  const database = makeDatabase()

  record(database, call('gmail_search_messages', { query: 'from:chef' }), 'BETREFF: Gehalt ' + 'geheim '.repeat(50))
  record(database, call('calendar_list_events', { timeMin: '2026-10-07' }, 'c2'), 'Zahnarzt 14:00')
  record(database, call('browser_navigate', { url: 'https://bank.example/konto' }, 'c3'), 'Kontostand 1234')
  record(database, call('read_chat_excerpt', { id: 'H1' }, 'c4'), 'Chattext')

  const events = listToolEvents(database, 1)

  assert.equal(events.length, 4)
  assert.ok(events.every(event => event.summary === ''))
  assert.equal(events[0].args, 'from:chef')
  assert.match(events[1].args, /timeMin/)
  assert.ok(!JSON.stringify(events).includes('Gehalt'))
  assert.ok(!JSON.stringify(events).includes('Kontostand'))
})

test('Geheimnisse werden in Argumenten und Auszug geschwaerzt', () => {
  const database = makeDatabase()
  const key = 'sk-' + 'A1b2C3d4'.repeat(4)

  record(database, call('web_search', { query: `wie nutze ich ${key}` }), `Treffer mit TOKEN=abc123def und ${key}`)

  const [event] = listToolEvents(database, 1)

  assert.ok(!event.args.includes(key))
  assert.ok(!event.summary.includes(key))
  assert.ok(!event.summary.includes('abc123def'))
  assert.match(event.summary, /REDACTED/)
  assert.equal(redactSecrets('Bearer ' + 'x'.repeat(30)), 'Bearer ***REDACTED***')
})

test('Fehler und Ablehnungen werden erkannt, normale Texte mit "error" nicht', () => {
  const cases = [
    ['Gmail error: token expired', 'error'],
    ['Search error: HTTP 403', 'error'],
    ['Search timeout', 'error'],
    ['Tool blocked for this request: terminal', 'error'],
    ['Blocked: URL enthaelt verdaechtige Parameter', 'error'],
    ['Unknown tool: foo', 'error'],
    ['Playwright MCP error: page crashed', 'error'],
    ['Calendar action denied by user', 'denied'],
    ['Calendar action approval expired', 'denied'],
    ['No errors found in the logs, alles ok', 'ok'],
    ['1. Treffer eins', 'ok'],
    ['', 'ok']
  ]

  for (const [text, expected] of cases) {
    assert.equal(toolResultStatus(text), expected, text)
  }
})

test('Argument-Kurzfassung: Anfrage, URL, sonst JSON', () => {
  assert.equal(summarizeToolArgs({ query: ' abc ' }), 'abc')
  assert.equal(summarizeToolArgs({ url: 'https://x.example/a' }), 'https://x.example/a')
  assert.equal(summarizeToolArgs({ path: '/a', ref: 'main' }), '{"path":"/a","ref":"main"}')
  assert.equal(summarizeToolArgs({}), '')
  assert.equal(summarizeToolArgs(null), '')
})

test('Neu-Erzeugen loescht nur die Aufrufe dieser Nachricht', () => {
  const database = makeDatabase()

  record(database, call('web_search', { query: 'a' }), 'x', { userMessageId: 1 })
  record(database, call('web_search', { query: 'b' }, 'c2'), 'x', { userMessageId: 2 })

  assert.equal(clearToolEvents(database, 1, 1), 1)
  assert.deepEqual(listToolEvents(database, 1).map(event => event.args), ['b'])
})

test('Fehler beim Speichern stoeren den Chat nie', () => {
  const broken = {
    exec() { throw new Error('disk full') },
    prepare() { throw new Error('disk full') }
  }
  const originalError = console.error
  console.error = () => {}

  try {
    assert.equal(record(broken, call('web_search', { query: 'a' }), 'x'), null)
    assert.equal(clearToolEvents(broken, 1, 1), 0)
  } finally {
    console.error = originalError
  }
})

test('Protokoll-Text: Kopfzeile, Status, begrenzte Laenge', () => {
  const log = formatToolLog([
    { tool: 'web_search', args: 'Preise', status: 'ok', summary: '1. Treffer\n2. Treffer' },
    { tool: 'firecrawl_scrape', args: 'https://x.example', status: 'error', summary: 'Scrape timeout' },
    { tool: 'gmail_search_messages', args: 'from:chef', status: 'denied', summary: '' }
  ])

  assert.ok(log.startsWith(TOOL_LOG_MARKER))
  assert.match(log, /3 Aufruf\(e\), die du fuer die vorige Nachricht des Nutzers gemacht hast/)
  assert.match(log, /Nicht wiederholen/)
  assert.match(log, /- web_search `Preise` \(ok\)\n {4}1\. Treffer\n {4}2\. Treffer/)
  assert.match(log, /- firecrawl_scrape `https:\/\/x\.example` \(Fehler\)/)
  assert.match(log, /- gmail_search_messages `from:chef` \(abgelehnt\)$/)

  const many = formatToolLog(Array.from({ length: 40 }, (_, index) => ({
    tool: 'web_search', args: `anfrage-${index}`, status: 'ok', summary: 'o'.repeat(480)
  })))

  assert.match(many, /40 Aufruf\(e\)/)
  assert.match(many, /\(\d+ aeltere Aufrufe ausgelassen\)/)
  assert.ok(many.includes('anfrage-39'))
  assert.ok(many.length < 4200, `Laenge ${many.length}`)
})

test('Verlauf: Werkzeug-Protokoll steht direkt hinter der passenden Nutzer-Nachricht', () => {
  const database = makeDatabase()

  const firstUser = addMessage(database, 1, 'user', 'Wie sind die Preise von Claude und GPT?')

  recordToolEvent(database, {
    conversationId: 1, userMessageId: firstUser, requestId: 'r1',
    toolCall: call('web_search', { query: 'Claude Preise' }),
    result: '1. Haiku 4.5: $1/$5'
  })
  recordToolEvent(database, {
    conversationId: 1, userMessageId: firstUser, requestId: 'r1',
    toolCall: call('firecrawl_scrape', { url: 'https://example.com/pricing' }, 'call_2'),
    result: 'Pricing page ...'
  })

  database.prepare(`INSERT INTO chat_terminal_operations (id, command, status, result) VALUES ('op1', 'uptime', 'succeeded', 'up 78 days')`).run()
  addMessage(database, 1, 'assistant', '**Terminal:** `uptime`\n```\nup 78 days\n```', 'op1')
  addMessage(database, 1, 'assistant', 'Haiku kostet $1 / $5 pro Million Tokens.')
  addMessage(database, 1, 'user', 'danke')

  // Fremde Konversation und verwaiste Eintraege duerfen nichts veraendern.
  addMessage(database, 2, 'user', 'anderer Chat')
  recordToolEvent(database, {
    conversationId: 2, userMessageId: 999, requestId: 'x',
    toolCall: call('web_search', { query: 'fremd' }), result: 'FREMD'
  })
  recordToolEvent(database, {
    conversationId: 1, userMessageId: 12345, requestId: 'x',
    toolCall: call('web_search', { query: 'verwaist' }), result: 'VERWAIST'
  })
  database.prepare(`
    INSERT INTO chat_tool_events (conversation_id, user_message_id, tool, args)
    VALUES (1, NULL, 'web_search', 'ohne-nachricht')
  `).run()

  const history = loadModelHistory(database, 1)

  assert.deepEqual(history.map(row => row.role), [
    'user', 'assistant', 'assistant', 'assistant', 'user'
  ])
  assert.ok(history[1].content.startsWith(TOOL_LOG_MARKER))
  assert.match(history[1].content, /2 Aufruf\(e\)/)
  assert.match(history[1].content, /- web_search `Claude Preise` \(ok\)\n {4}1\. Haiku 4\.5: \$1\/\$5/)
  assert.match(history[1].content, /- firecrawl_scrape `https:\/\/example\.com\/pricing` \(ok\)/)
  assert.ok(history[2].content.startsWith(TERMINAL_LOG_MARKER))
  assert.equal(history[3].content, 'Haiku kostet $1 / $5 pro Million Tokens.')

  const all = JSON.stringify(history)

  assert.ok(!all.includes('FREMD'))
  assert.ok(!all.includes('VERWAIST'))
  assert.ok(!all.includes('ohne-nachricht'))
  assert.equal(hasTerminalLog(history), true)
})

test('ohne Werkzeugaufrufe bleibt der Verlauf unveraendert', () => {
  const database = makeDatabase()

  addMessage(database, 1, 'user', 'hi')
  addMessage(database, 1, 'assistant', 'hallo')

  const history = loadModelHistory(database, 1)

  assert.deepEqual(history.map(row => row.content), ['hi', 'hallo'])
  assert.equal(hasTerminalLog(history), false)
})

function read(file) {
  return readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
}

test('chat.js erfasst jeden Werkzeugaufruf und raeumt beim Neu-Erzeugen auf', () => {
  const chat = read('server/routes/chat.js')

  assert.match(chat, /from '\.\.\/lib\/toolEvents\.js'/)
  assert.match(chat, /clearToolEvents\(db, convo\.id, currentUserMessageId\)/)

  const record = chat.indexOf('recordToolEvent(db, {')
  const push = chat.indexOf("role: 'tool'")

  assert.ok(record > 0 && push > record, 'Aufruf wird vor dem Weiterreichen an das Modell erfasst')
})
