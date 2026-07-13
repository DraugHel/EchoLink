import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {
  cleanupScheduledTasks
} from '../server/lib/taskCleanup.js'

const DAY = 24 * 60 * 60

test('Task-Cleanup respektiert Aufbewahrungszeiten', () => {
  const db = new Database(':memory:')
  const now = 1_800_000_000

  db.exec(`
    CREATE TABLE scheduled_tasks (
      id INTEGER PRIMARY KEY,
      schedule_kind TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      locked_at INTEGER,
      last_run_at INTEGER,
      created_at INTEGER,
      updated_at INTEGER
    );

    CREATE TABLE task_runs (
      id INTEGER PRIMARY KEY,
      task_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER
    );
  `)

  const insertTask = db.prepare(`
    INSERT INTO scheduled_tasks (
      id,
      schedule_kind,
      enabled,
      locked_at,
      last_run_at,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, NULL, ?, ?, ?)
  `)

  insertTask.run(
    1,
    'once',
    0,
    now - 31 * DAY,
    now - 31 * DAY,
    now - 31 * DAY
  )

  insertTask.run(
    2,
    'once',
    0,
    now - 29 * DAY,
    now - 29 * DAY,
    now - 29 * DAY
  )

  insertTask.run(
    3,
    'cron',
    0,
    now - 200 * DAY,
    now - 200 * DAY,
    now - 200 * DAY
  )

  const insertRun = db.prepare(`
    INSERT INTO task_runs (
      id,
      task_id,
      status,
      started_at,
      finished_at
    )
    VALUES (?, ?, 'success', ?, ?)
  `)

  insertRun.run(
    1,
    1,
    now - 31 * DAY,
    now - 31 * DAY
  )

  insertRun.run(
    2,
    3,
    now - 91 * DAY,
    now - 91 * DAY
  )

  insertRun.run(
    3,
    3,
    now - 10 * DAY,
    now - 10 * DAY
  )

  const result = cleanupScheduledTasks(db, { now })

  assert.equal(result.deletedTasks, 1)
  assert.equal(result.deletedRuns, 2)

  assert.deepEqual(
    db.prepare(`
      SELECT id
      FROM scheduled_tasks
      ORDER BY id
    `).all(),
    [{ id: 2 }, { id: 3 }]
  )

  assert.deepEqual(
    db.prepare(`
      SELECT id
      FROM task_runs
      ORDER BY id
    `).all(),
    [{ id: 3 }]
  )

  db.close()
})
