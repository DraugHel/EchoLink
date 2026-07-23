import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  mkdtemp,
  readFile,
  rm
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import Database from 'better-sqlite3'

import {
  approveTerminalOperation,
  createTerminalOperation,
  ensureTerminalOperationSchema,
  executeTerminalOperation,
  formatTerminalContinuationContext,
  getTerminalOperation,
  isSelfDisruptiveTerminalCommand,
  spawnTerminalOperationRunner,
  waitForTerminalOperation
} from '../server/lib/terminalOperations.js'

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)

function testDatabase() {
  const database = new Database(':memory:')

  database.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE users (
      id INTEGER PRIMARY KEY
    );

    CREATE TABLE conversations (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      updated_at INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      FOREIGN KEY (conversation_id)
        REFERENCES conversations(id)
    );

    INSERT INTO users (id) VALUES (7);
    INSERT INTO conversations (id, user_id) VALUES (42, 7);
  `)

  ensureTerminalOperationSchema(database)
  return database
}

test('freigegebene Terminal-Operation wird auch bei Doppelstart exakt einmal ausgeführt', async () => {
  const database = testDatabase()
  let executions = 0

  const operation = createTerminalOperation({
    userId: 7,
    conversationId: 42,
    requestId: 'restart-request-1',
    toolCallId: 'tool-call-1',
    command: 'pm2 restart echolink',
    description: 'EchoLink neu starten',
    requiresApproval: true,
    database
  })

  const firstApproval = approveTerminalOperation(
    operation.action_id,
    7,
    database
  )
  const secondApproval = approveTerminalOperation(
    operation.action_id,
    7,
    database
  )

  assert.equal(firstApproval.shouldStart, true)
  assert.equal(secondApproval.shouldStart, false)

  const execFn = (_command, _options, callback) => {
    executions += 1
    setTimeout(() => callback(null, 'restarted\n', ''), 20)
  }

  const [first, second] = await Promise.all([
    executeTerminalOperation(operation.id, {
      database,
      execFn
    }),
    executeTerminalOperation(operation.id, {
      database,
      execFn
    })
  ])

  assert.equal(executions, 1)
  assert.equal(first.status, 'succeeded')
  assert.equal(second.status, 'succeeded')
  assert.equal(first.result, 'restarted\n')

  const messages = database.prepare(`
    SELECT *
    FROM messages
    WHERE source_terminal_operation_id = ?
  `).all(operation.id)

  assert.equal(messages.length, 1)
  database.close()
})

test('Reconnect-Kontext markiert fertige Befehle ausdrücklich als nicht zu wiederholen', async () => {
  const database = testDatabase()
  const operation = createTerminalOperation({
    userId: 7,
    conversationId: 42,
    requestId: 'deploy-request-1',
    toolCallId: 'tool-call-deploy',
    command: 'cd /root/echolink && npm run deploy',
    requiresApproval: false,
    database
  })

  await executeTerminalOperation(operation.id, {
    database,
    execFn: (_command, _options, callback) =>
      callback(null, 'Deploy erfolgreich.\n', '')
  })

  const completed = getTerminalOperation(operation.id, database)
  const context = formatTerminalContinuationContext([completed])

  assert.match(context, /already been handled/i)
  assert.match(context, /NEVER execute any listed command again/)
  assert.match(context, /npm run deploy/)
  assert.match(context, /Deploy erfolgreich/)
  database.close()
})

test('abgekoppelter Runner erhält nur Operations-ID und überlebt den Elternprozess', () => {
  const database = testDatabase()
  const operation = createTerminalOperation({
    userId: 7,
    conversationId: 42,
    requestId: 'runner-request-1',
    toolCallId: 'runner-tool-1',
    command: 'pm2 restart echolink',
    requiresApproval: false,
    database
  })
  let spawnCall
  let unrefCalled = false

  const pid = spawnTerminalOperationRunner(operation.id, {
    database,
    nodePath: '/usr/bin/node',
    spawnFn(command, args, options) {
      spawnCall = { command, args, options }
      return {
        pid: 4321,
        unref() {
          unrefCalled = true
        }
      }
    }
  })

  assert.equal(pid, 4321)
  assert.equal(spawnCall.command, '/usr/bin/node')
  assert.equal(spawnCall.args.at(-1), operation.id)
  assert.equal(spawnCall.options.detached, true)
  assert.equal(spawnCall.options.stdio, 'ignore')
  assert.equal(unrefCalled, true)
  database.close()
})

test('echter detached Runner übernimmt die Operation über eine neue DB-Verbindung', async () => {
  const tempDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'echolink-terminal-runner-')
  )
  const databasePath = path.join(tempDirectory, 'echolink.db')
  const runnerEnv = {
    ...process.env,
    ECHOLINK_DB_PATH: databasePath
  }

  try {
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        "await import('./server/db.js')"
      ],
      {
        cwd: projectRoot,
        env: runnerEnv,
        stdio: 'pipe'
      }
    )

    const database = new Database(databasePath)
    database.prepare(`
      INSERT INTO users (id, username, password_hash)
      VALUES (7, 'runner-test', 'not-a-real-hash')
    `).run()
    database.prepare(`
      INSERT INTO conversations (id, user_id, title, model)
      VALUES (42, 7, 'Runner test', 'test-model')
    `).run()
    ensureTerminalOperationSchema(database)

    const operation = createTerminalOperation({
      userId: 7,
      conversationId: 42,
      requestId: 'real-runner-request-1',
      toolCallId: 'real-runner-tool-1',
      command: "printf 'detached-ok\\n'",
      requiresApproval: false,
      database
    })

    const pid = spawnTerminalOperationRunner(operation.id, {
      database,
      env: runnerEnv
    })
    assert.ok(Number(pid) > 0)

    const completed = await waitForTerminalOperation(
      operation.id,
      {
        database,
        timeoutMs: 10_000,
        pollMs: 25
      }
    )

    assert.equal(completed.status, 'succeeded')
    assert.equal(completed.result, 'detached-ok\n')
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM messages
        WHERE source_terminal_operation_id = ?
      `).get(operation.id).count,
      1
    )
    database.close()
  } finally {
    await rm(tempDirectory, {
      recursive: true,
      force: true
    })
  }
})

test('Restart- und Deploy-Kommandos bekommen das längere Handoff-Zeitfenster', () => {
  assert.equal(
    isSelfDisruptiveTerminalCommand('pm2 restart echolink --update-env'),
    true
  )
  assert.equal(
    isSelfDisruptiveTerminalCommand('cd /root/echolink && npm run deploy'),
    true
  )
  assert.equal(
    isSelfDisruptiveTerminalCommand('pm2 status'),
    false
  )
})

test('abgelaufene Freigaben lassen sich nach einem Restart nicht nachträglich starten', () => {
  const database = testDatabase()
  const operation = createTerminalOperation({
    userId: 7,
    conversationId: 42,
    requestId: 'expired-request-1',
    toolCallId: 'expired-tool-1',
    command: 'touch /tmp/should-not-run',
    requiresApproval: true,
    database
  })

  database.prepare(`
    UPDATE chat_terminal_operations
    SET expires_at = 0
    WHERE id = ?
  `).run(operation.id)

  const approval = approveTerminalOperation(
    operation.action_id,
    7,
    database
  )

  assert.equal(approval.shouldStart, false)
  assert.equal(approval.operation.status, 'expired')
  database.close()
})

test('Chat-Reconnect sendet während des Laufs ergänzte Checkpoints weiter', async () => {
  const source = await readFile(
    new URL('../client/src/pages/Chat.jsx', import.meta.url),
    'utf8'
  )

  assert.match(
    source,
    /let continuationCheckpoints = Array\.isArray\(resumeCheckpoints\)/
  )
  assert.match(
    source,
    /resumeCheckpoints: continuationCheckpoints/
  )
  assert.match(
    source,
    /continuationCheckpoints = \[\s*\.\.\.continuationCheckpoints,\s*json\.checkpoint/
  )
})
