import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  mkdtemp,
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
  reconcileRunningTerminalOperations,
  spawnTerminalOperationRunner,
  terminalOperationUnitName,
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

  let executionCwd = ''
  const execFn = (_command, _options, callback) => {
    executions += 1
    executionCwd = _options.cwd
    setTimeout(() => callback(null, 'restarted\n', ''), 20)
  }

  const [first, second] = await Promise.all([
    executeTerminalOperation(operation.id, {
      database,
      execFn,
      runnerPid: 7654
    }),
    executeTerminalOperation(operation.id, {
      database,
      execFn,
      runnerPid: 7654
    })
  ])

  assert.equal(executions, 1)
  assert.equal(path.resolve(executionCwd), projectRoot)
  assert.equal(first.status, 'succeeded')
  assert.equal(second.status, 'succeeded')
  assert.equal(first.result, 'restarted\n')
  assert.equal(
    getTerminalOperation(operation.id, database).runner_pid,
    7654
  )

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

test('gewöhnlicher Runner bleibt ein lokal abgekoppelter Prozess', () => {
  const database = testDatabase()
  const operation = createTerminalOperation({
    userId: 7,
    conversationId: 42,
    requestId: 'runner-request-1',
    toolCallId: 'runner-tool-1',
    command: "printf 'ordinary-runner\\n'",
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
  assert.equal(
    getTerminalOperation(operation.id, database).runner_kind,
    'process'
  )
  database.close()
})

test('selbstunterbrechender Runner wird ohne Secret-Vererbung an systemd übergeben', () => {
  const database = testDatabase()
  const operation = createTerminalOperation({
    userId: 7,
    conversationId: 42,
    requestId: 'systemd-runner-request-1',
    toolCallId: 'systemd-runner-tool-1',
    command: "bash -lc 'cd /root/echolink && npm run deploy'",
    requiresApproval: false,
    database
  })
  let launch
  let localSpawnCalled = false

  const pid = spawnTerminalOperationRunner(operation.id, {
    database,
    nodePath: '/usr/bin/node',
    systemdRunPath: '/usr/bin/systemd-run',
    env: {
      HOME: '/root',
      PATH: '/usr/local/bin:/usr/bin',
      ECHOLINK_DB_PATH: '/tmp/test-echolink.db',
      SECRET_SENTINEL: 'must-not-enter-unit-args'
    },
    spawnFn() {
      localSpawnCalled = true
      throw new Error('local spawn must not be used')
    },
    spawnSyncFn(command, args, options) {
      launch = { command, args, options }
      return {
        pid: 4321,
        status: 0,
        stdout: '',
        stderr: ''
      }
    }
  })

  const stored = getTerminalOperation(operation.id, database)
  const unitName = terminalOperationUnitName(operation.id)

  assert.equal(pid, 4321)
  assert.equal(localSpawnCalled, false)
  assert.equal(launch.command, '/usr/bin/systemd-run')
  assert.ok(launch.args.includes('--collect'))
  assert.ok(launch.args.includes(`--unit=${unitName}`))
  assert.ok(launch.args.includes('--service-type=exec'))
  assert.ok(launch.args.includes('--property=UMask=0022'))
  assert.ok(
    launch.args.includes('--property=RuntimeMaxSec=510s')
  )
  assert.equal(
    path.resolve(
      launch.args
        .find(arg => arg.startsWith('--working-directory='))
        .slice('--working-directory='.length)
    ),
    projectRoot
  )
  assert.equal(launch.args.at(-1), operation.id)
  assert.ok(
    launch.args.includes(
      '--setenv=ECHOLINK_DB_PATH=/tmp/test-echolink.db'
    )
  )
  assert.doesNotMatch(
    launch.args.join('\n'),
    /SECRET_SENTINEL|must-not-enter-unit-args/
  )
  assert.equal(stored.runner_kind, 'systemd')
  assert.equal(stored.runner_ref, unitName)
  assert.equal(stored.runner_pid, null)
  assert.ok(stored.heartbeat_at > 0)
  assert.equal(stored.status, 'queued')
  database.close()
})

test('bereits aktive systemd-Unit wird bei erneutem Startversuch nicht dupliziert', () => {
  const database = testDatabase()
  const operation = createTerminalOperation({
    userId: 7,
    conversationId: 42,
    requestId: 'systemd-idempotency-request-1',
    toolCallId: 'systemd-idempotency-tool-1',
    command: 'npm run deploy',
    requiresApproval: false,
    database
  })
  let launches = 0

  spawnTerminalOperationRunner(operation.id, {
    database,
    spawnSyncFn() {
      launches += 1
      return {
        pid: 4323,
        status: 0,
        stdout: '',
        stderr: ''
      }
    }
  })

  const repeatedPid = spawnTerminalOperationRunner(operation.id, {
    database,
    spawnSyncFn() {
      launches += 1
      throw new Error('active unit must not be launched again')
    },
    systemdStateFn: () => true
  })

  assert.equal(repeatedPid, null)
  assert.equal(launches, 1)
  assert.equal(
    getTerminalOperation(operation.id, database).status,
    'queued'
  )
  database.close()
})

test('inaktive frühere systemd-Unit wird nicht automatisch neu gestartet', () => {
  const database = testDatabase()
  const operation = createTerminalOperation({
    userId: 7,
    conversationId: 42,
    requestId: 'systemd-no-retry-request-1',
    toolCallId: 'systemd-no-retry-tool-1',
    command: 'npm run deploy',
    requiresApproval: false,
    database
  })
  let launches = 0

  spawnTerminalOperationRunner(operation.id, {
    database,
    spawnSyncFn() {
      launches += 1
      return {
        pid: 4325,
        status: 0,
        stdout: '',
        stderr: ''
      }
    }
  })

  const repeatedPid = spawnTerminalOperationRunner(operation.id, {
    database,
    spawnSyncFn() {
      launches += 1
      throw new Error('inactive unit must not be retried')
    },
    systemdStateFn: () => false
  })

  const stored = getTerminalOperation(operation.id, database)

  assert.equal(repeatedPid, null)
  assert.equal(launches, 1)
  assert.equal(stored.status, 'failed')
  assert.match(stored.result, /not executed/i)
  assert.match(stored.error, /not retried automatically/i)
  database.close()
})

test('verlorene systemd-run-Antwort erzeugt keinen falschen Fehler oder Ersatzstart', () => {
  const database = testDatabase()
  const operation = createTerminalOperation({
    userId: 7,
    conversationId: 42,
    requestId: 'systemd-ack-request-1',
    toolCallId: 'systemd-ack-tool-1',
    command: 'npm run deploy',
    requiresApproval: false,
    database
  })

  const pid = spawnTerminalOperationRunner(operation.id, {
    database,
    spawnSyncFn() {
      return {
        pid: 4324,
        status: 1,
        stdout: '',
        stderr: 'transport acknowledgement lost'
      }
    },
    systemdStateFn: () => true
  })

  const stored = getTerminalOperation(operation.id, database)

  assert.equal(pid, null)
  assert.equal(stored.status, 'queued')
  assert.equal(stored.runner_kind, 'systemd')
  assert.equal(stored.runner_ref, terminalOperationUnitName(operation.id))
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) AS count
      FROM messages
      WHERE source_terminal_operation_id = ?
    `).get(operation.id).count,
    0
  )
  database.close()
})

test('systemd-Startfehler schlägt geschlossen fehl und nutzt keinen lokalen Fallback', () => {
  const database = testDatabase()
  const operation = createTerminalOperation({
    userId: 7,
    conversationId: 42,
    requestId: 'systemd-runner-request-2',
    toolCallId: 'systemd-runner-tool-2',
    command: 'npm run deploy',
    requiresApproval: false,
    database
  })
  let localSpawnCalled = false

  const pid = spawnTerminalOperationRunner(operation.id, {
    database,
    spawnFn() {
      localSpawnCalled = true
      throw new Error('unsafe fallback')
    },
    spawnSyncFn() {
      return {
        pid: 4322,
        status: 1,
        stdout: '',
        stderr: 'systemd unavailable'
      }
    },
    systemdStateFn: () => false
  })

  const failed = getTerminalOperation(operation.id, database)

  assert.equal(pid, null)
  assert.equal(localSpawnCalled, false)
  assert.equal(failed.status, 'failed')
  assert.match(
    failed.result,
    /command was not executed/i
  )
  assert.match(
    failed.error,
    /systemd runner launch failed/i
  )
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) AS count
      FROM messages
      WHERE source_terminal_operation_id = ?
    `).get(operation.id).count,
    1
  )
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

    assert.equal(
      completed.status,
      'succeeded',
      completed.result ||
        completed.error ||
        'Detached terminal runner failed without diagnostics'
    )
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

test('verwaiste laufende Operation wird fehlgeschlagen markiert und nie automatisch wiederholt', () => {
  const database = testDatabase()
  const operation = createTerminalOperation({
    userId: 7,
    conversationId: 42,
    requestId: 'orphan-request-1',
    toolCallId: 'orphan-tool-1',
    command: 'npm run deploy',
    requiresApproval: false,
    database
  })

  database.prepare(`
    UPDATE chat_terminal_operations
    SET
      status = 'running',
      started_at = 1000,
      heartbeat_at = 1000,
      runner_pid = 999999,
      runner_kind = 'process'
    WHERE id = ?
  `).run(operation.id)

  let stateChecks = 0
  const summary = reconcileRunningTerminalOperations({
    database,
    currentTime: 20_000,
    runnerStateFn() {
      stateChecks += 1
      return false
    }
  })

  const failed = getTerminalOperation(operation.id, database)
  assert.equal(stateChecks, 1)
  assert.equal(summary.orphaned, 1)
  assert.equal(failed.status, 'failed')
  assert.match(failed.result, /not retried automatically/i)
  assert.match(failed.result, /manual verification/i)

  const second = reconcileRunningTerminalOperations({
    database,
    currentTime: 30_000,
    runnerStateFn() {
      throw new Error('finished operation must not be checked')
    }
  })

  assert.equal(second.checked, 0)
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) AS count
      FROM messages
      WHERE source_terminal_operation_id = ?
    `).get(operation.id).count,
    1
  )
  database.close()
})

test('lebender oder nicht eindeutig prüfbarer Runner wird nicht als Erfolg oder Fehler geraten', () => {
  const database = testDatabase()

  for (const [requestId, runnerPid] of [
    ['alive-request', 1001],
    ['ambiguous-request', 1002]
  ]) {
    const operation = createTerminalOperation({
      userId: 7,
      conversationId: 42,
      requestId,
      toolCallId: `${requestId}-tool`,
      command: "printf 'still-running\\n'",
      requiresApproval: false,
      database
    })

    database.prepare(`
      UPDATE chat_terminal_operations
      SET
        status = 'running',
        started_at = 1000,
        heartbeat_at = 1000,
        runner_pid = ?,
        runner_kind = 'process'
      WHERE id = ?
    `).run(runnerPid, operation.id)
  }

  const summary = reconcileRunningTerminalOperations({
    database,
    currentTime: 20_000,
    runnerStateFn(operation) {
      return operation.runner_pid === 1001
        ? true
        : null
    }
  })

  assert.equal(summary.alive, 1)
  assert.equal(summary.ambiguous, 1)
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) AS count
      FROM chat_terminal_operations
      WHERE status = 'running'
    `).get().count,
    2
  )
  database.close()
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

test('systemd-Unitname akzeptiert ausschließlich vollständige Operations-UUIDs', () => {
  assert.equal(
    terminalOperationUnitName(
      '12345678-1234-4abc-8def-1234567890ab'
    ),
    'echolink-terminal-12345678-1234-4abc-8def-1234567890ab'
  )
  assert.throws(
    () => terminalOperationUnitName('../../unsafe'),
    /Invalid terminal operation ID/
  )
})
