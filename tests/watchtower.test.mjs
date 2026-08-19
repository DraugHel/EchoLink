import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {
  evaluateWatchtowerSnapshot,
  formatWatchtowerIncident,
  formatWatchtowerRepair,
  selectWatchtowerAutoHealTargets
} from '../server/lib/watchtowerCore.js'
import {
  getWatchtowerStatus,
  runWatchtowerCycle,
  setWatchtowerEnabled
} from '../server/lib/watchtower.js'

function testDb() {
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  database.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      default_system_prompt TEXT DEFAULT ''
    );
    CREATE TABLE conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      model TEXT NOT NULL,
      system_prompt TEXT DEFAULT '',
      temperature REAL DEFAULT 0.5,
      top_k INTEGER DEFAULT 40,
      top_p REAL DEFAULT 0.9,
      reasoning_effort TEXT DEFAULT '',
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch()),
      archived_at INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );
    CREATE TABLE watchtower_settings (
      user_id INTEGER PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      conversation_id INTEGER,
      disk_warning_percent INTEGER NOT NULL DEFAULT 85,
      last_check_at INTEGER,
      last_success_at INTEGER,
      last_error TEXT,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
    );
    CREATE TABLE watchtower_incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      monitor_key TEXT NOT NULL,
      status TEXT NOT NULL,
      severity TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      summary TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      opened_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      resolved_at INTEGER,
      last_notified_at INTEGER,
      consecutive_count INTEGER NOT NULL DEFAULT 1,
      UNIQUE(user_id, monitor_key),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE watchtower_repair_state (
      app_name TEXT PRIMARY KEY,
      incident_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL,
      attempted_at INTEGER NOT NULL,
      verified_at INTEGER,
      detail TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE watchtower_repair_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_name TEXT NOT NULL,
      incident_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL,
      attempted_at INTEGER NOT NULL,
      verified_at INTEGER NOT NULL,
      detail TEXT NOT NULL DEFAULT ''
    );
  `)
  database.prepare(`
    INSERT INTO users (id, default_system_prompt)
    VALUES (1, 'You are Echo. Respond in the user language.')
  `).run()
  return database
}

function healthySnapshot() {
  return {
    disk: { usedPercent: 60, freeGb: 28 },
    apps: [
      'echolink',
      'echolink-worker',
      'echolink-mcp-web',
      'echolink-mcp-playwright'
    ].map(name => ({ name, status: 'online' })),
    health: [
      { name: 'EchoLink', ok: true },
      { name: 'MCP Web', ok: true }
    ],
    mcpServers: [
      {
        name: 'mcp-web',
        mode: 'active',
        configured: true,
        reachable: true,
        circuitBreaker: { state: 'closed' }
      }
    ]
  }
}

test('Watchtower-Befunde sind stabil und enthalten keine gesunden Checks', () => {
  assert.deepEqual(
    evaluateWatchtowerSnapshot(healthySnapshot()),
    []
  )

  const snapshot = healthySnapshot()
  snapshot.disk = { usedPercent: 93, freeGb: 4.9 }
  snapshot.apps.find(app => app.name === 'echolink-mcp-web').status = 'stopped'

  const findings = evaluateWatchtowerSnapshot(snapshot)
  assert.deepEqual(
    findings.map(item => item.key),
    ['disk:root', 'pm2:required-apps']
  )
  assert.equal(findings[0].severity, 'critical')
  assert.match(findings[0].detail, /nichts gelöscht/)
})

test('Watchtower formatiert Vorfall und Entwarnung ohne Reparaturbehauptung', () => {
  const incident = {
    severity: 'warning',
    summary: 'Root-Speicher wird knapp',
    detail: '/ ist zu 86% belegt.'
  }

  assert.match(
    formatWatchtowerIncident(incident),
    /Es wurde nichts gelöscht/
  )
  assert.match(
    formatWatchtowerIncident(incident, { resolved: true }),
    /Entwarnung/
  )

  assert.match(
    formatWatchtowerRepair({
      appName: 'echolink-mcp-playwright',
      ok: true
    }),
    /Auto-Healing erfolgreich/
  )
})

test('Auto-Healing wählt ausschließlich die fest eingebaute sichere Allowlist', () => {
  const snapshot = healthySnapshot()

  for (const app of snapshot.apps) {
    app.status = 'stopped'
  }
  snapshot.apps.push({
    name: 'caller-controlled-app',
    status: 'stopped'
  })

  assert.deepEqual(
    selectWatchtowerAutoHealTargets(snapshot, {
      expectedApps: [
        ...snapshot.apps.map(app => app.name),
        'caller-controlled-app'
      ]
    }),
    [
      'echolink',
      'echolink-mcp-web',
      'echolink-mcp-playwright'
    ]
  )
})

test('Auto-Healing startet einen PM2-Prozess einmal und verifiziert ihn', async t => {
  const database = testDb()
  t.after(() => database.close())
  const failed = healthySnapshot()
  failed.apps.find(
    app => app.name === 'echolink-mcp-playwright'
  ).status = 'stopped'
  const restarted = []

  const run = options => runWatchtowerCycle({
    database,
    checkedAt: options.checkedAt,
    snapshot: options.snapshot,
    restartApp: async appName => restarted.push(appName),
    collectSnapshot: async () => healthySnapshot(),
    settle: async () => {}
  })

  await run({ snapshot: failed, checkedAt: 100 })

  assert.deepEqual(restarted, ['echolink-mcp-playwright'])
  const messages = database.prepare(`
    SELECT content FROM messages ORDER BY id
  `).all()
  assert.equal(messages.length, 2)
  assert.match(messages[0].content, /Kritischer Vorfall/)
  assert.match(messages[1].content, /Auto-Healing erfolgreich/)
  assert.equal(getWatchtowerStatus(database, 1).incidents.length, 0)
  assert.equal(
    getWatchtowerStatus(database, 1).autoHealing.lastAttempt.status,
    'succeeded'
  )
  assert.equal(
    database.prepare(`
      SELECT count(*) AS n FROM watchtower_repair_history
    `).get().n,
    1
  )

  await run({ snapshot: failed, checkedAt: 200 })
  assert.equal(restarted.length, 1)

  await run({ snapshot: healthySnapshot(), checkedAt: 300 })
  await run({ snapshot: failed, checkedAt: 400 })
  assert.equal(restarted.length, 2)
})

test('fehlgeschlagenes Auto-Healing bleibt bis zu einem gesunden Check gesperrt', async t => {
  const database = testDb()
  t.after(() => database.close())
  const failed = healthySnapshot()
  failed.apps.find(
    app => app.name === 'echolink-mcp-web'
  ).status = 'stopped'
  let restartCount = 0

  const runFailed = checkedAt => runWatchtowerCycle({
    database,
    checkedAt,
    snapshot: failed,
    restartApp: async () => {
      restartCount++
      throw new Error('simulierter Neustartfehler')
    },
    collectSnapshot: async () => failed,
    settle: async () => {}
  })

  await runFailed(100)
  await runFailed(200)

  assert.equal(restartCount, 1)
  assert.equal(
    database.prepare(`
      SELECT status FROM watchtower_repair_state
      WHERE app_name = 'echolink-mcp-web'
    `).get().status,
    'failed'
  )
  assert.equal(
    database.prepare(`
      SELECT count(*) AS n FROM messages
      WHERE content LIKE '%Auto-Healing fehlgeschlagen%'
    `).get().n,
    1
  )
})

test('eigene Watchtower-Convo bleibt gesund still und Vorfälle werden dedupliziert', async t => {
  const database = testDb()
  t.after(() => database.close())
  const healthy = healthySnapshot()

  await runWatchtowerCycle({
    database,
    snapshot: healthy,
    checkedAt: 100
  })

  const conversation = database.prepare(`
    SELECT * FROM conversations WHERE title = 'Watchtower'
  `).get()
  assert.ok(conversation)
  assert.equal(
    database.prepare('SELECT count(*) AS n FROM messages').get().n,
    0
  )

  const diskWarning = healthySnapshot()
  diskWarning.disk = { usedPercent: 86, freeGb: 10 }

  await runWatchtowerCycle({
    database,
    snapshot: diskWarning,
    checkedAt: 200
  })
  await runWatchtowerCycle({
    database,
    snapshot: diskWarning,
    checkedAt: 300
  })

  assert.equal(
    database.prepare('SELECT count(*) AS n FROM messages').get().n,
    1
  )
  assert.equal(getWatchtowerStatus(database, 1).incidents.length, 1)

  await runWatchtowerCycle({
    database,
    snapshot: healthySnapshot(),
    checkedAt: 400
  })

  const messages = database.prepare(`
    SELECT content FROM messages ORDER BY id
  `).all()
  assert.equal(messages.length, 2)
  assert.match(messages[1].content, /Entwarnung/)
  assert.equal(getWatchtowerStatus(database, 1).incidents.length, 0)
})

test('flüchtige Health-Fehler brauchen Bestätigung und Pause stoppt Checks', async t => {
  const database = testDb()
  t.after(() => database.close())
  const failed = healthySnapshot()
  failed.health[0] = { name: 'EchoLink', ok: false }

  await runWatchtowerCycle({
    database,
    snapshot: failed,
    checkedAt: 100
  })
  assert.equal(
    database.prepare('SELECT count(*) AS n FROM messages').get().n,
    0
  )

  await runWatchtowerCycle({
    database,
    snapshot: failed,
    checkedAt: 200
  })
  assert.equal(
    database.prepare('SELECT count(*) AS n FROM messages').get().n,
    1
  )

  setWatchtowerEnabled(database, 1, false)
  const diskWarning = healthySnapshot()
  diskWarning.disk = { usedPercent: 99, freeGb: 0.5 }

  await runWatchtowerCycle({
    database,
    snapshot: diskWarning,
    checkedAt: 300
  })

  assert.equal(
    database.prepare('SELECT count(*) AS n FROM messages').get().n,
    1
  )
  assert.equal(getWatchtowerStatus(database, 1).enabled, false)
})
