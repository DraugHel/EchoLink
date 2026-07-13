import './loadEnv.js'
import db from './db.js'
import { computeNextRunAt } from './lib/scheduler.js'

const POLL_MS = Math.max(
  5_000,
  Number(process.env.TASK_POLL_MS) || 30_000
)

const LOCK_TIMEOUT_SECONDS = 5 * 60
const MAX_TASKS_PER_TICK = 25

let ticking = false
let stopping = false

const claimNextTask = db.transaction(now => {
  const task = db.prepare(`
    SELECT *
    FROM scheduled_tasks
    WHERE
      enabled = 1
      AND next_run_at IS NOT NULL
      AND next_run_at <= ?
      AND (
        locked_at IS NULL
        OR locked_at < ?
      )
    ORDER BY next_run_at ASC, id ASC
    LIMIT 1
  `).get(
    now,
    now - LOCK_TIMEOUT_SECONDS
  )

  if (!task) return null

  const claimed = db.prepare(`
    UPDATE scheduled_tasks
    SET locked_at = ?
    WHERE
      id = ?
      AND enabled = 1
      AND next_run_at IS NOT NULL
      AND next_run_at <= ?
      AND (
        locked_at IS NULL
        OR locked_at < ?
      )
  `).run(
    now,
    task.id,
    now,
    now - LOCK_TIMEOUT_SECONDS
  )

  return claimed.changes ? task : null
})

function nextRunAfter(task, fromMs) {
  if (task.schedule_kind === 'once') {
    return null
  }

  return computeNextRunAt(
    task.schedule_kind,
    task.schedule_value,
    task.timezone,
    fromMs
  )
}

function createRun(taskId, startedAt) {
  const result = db.prepare(`
    INSERT INTO task_runs (
      task_id,
      status,
      started_at
    )
    VALUES (?, 'running', ?)
  `).run(taskId, startedAt)

  return Number(result.lastInsertRowid)
}

function finishRun(
  runId,
  status,
  result,
  error,
  finishedAt
) {
  db.prepare(`
    UPDATE task_runs
    SET
      status = ?,
      result = ?,
      error = ?,
      finished_at = ?
    WHERE id = ?
  `).run(
    status,
    result || null,
    error || null,
    finishedAt,
    runId
  )
}

function completeTask(task, now, nextRunAt) {
  db.prepare(`
    UPDATE scheduled_tasks
    SET
      enabled = ?,
      next_run_at = ?,
      last_run_at = ?,
      locked_at = NULL,
      updated_at = ?
    WHERE id = ?
  `).run(
    nextRunAt === null ? 0 : 1,
    nextRunAt,
    now,
    now,
    task.id
  )
}

function failTask(task, now, nextRunAt) {
  db.prepare(`
    UPDATE scheduled_tasks
    SET
      enabled = ?,
      next_run_at = ?,
      last_run_at = ?,
      locked_at = NULL,
      updated_at = ?
    WHERE id = ?
  `).run(
    nextRunAt === null ? 0 : 1,
    nextRunAt,
    now,
    now,
    task.id
  )
}

function executeReminder(task) {
  const conversation = db.prepare(`
    SELECT id
    FROM conversations
    WHERE id = ? AND user_id = ?
  `).get(
    task.conversation_id,
    task.user_id
  )

  if (!conversation) {
    throw new Error(
      'Ziel-Unterhaltung existiert nicht mehr'
    )
  }

  const content = [
    `**Erinnerung: ${task.title}**`,
    '',
    task.prompt
  ].join('\n')

  db.prepare(`
    INSERT INTO messages (
      conversation_id,
      role,
      content
    )
    VALUES (?, 'assistant', ?)
  `).run(
    conversation.id,
    content
  )

  db.prepare(`
    UPDATE conversations
    SET updated_at = unixepoch()
    WHERE id = ?
  `).run(conversation.id)

  return content
}

async function executeTask(task) {
  if (task.task_type === 'reminder') {
    return executeReminder(task)
  }

  throw new Error(
    `Unbekannter Task-Typ: ${task.task_type}`
  )
}

async function processTask(task) {
  const startedAt = Math.floor(Date.now() / 1000)
  const runId = createRun(task.id, startedAt)

  try {
    const result = await executeTask(task)
    const finishedAt = Math.floor(Date.now() / 1000)

    const nextRunAt = nextRunAfter(
      task,
      Date.now()
    )

    finishRun(
      runId,
      'success',
      String(result).slice(0, 20_000),
      null,
      finishedAt
    )

    completeTask(task, finishedAt, nextRunAt)

    console.log(JSON.stringify({
      level: 'info',
      event: 'scheduled_task_completed',
      taskId: task.id,
      userId: task.user_id,
      nextRunAt
    }))
  } catch (error) {
    const finishedAt = Math.floor(Date.now() / 1000)

    let nextRunAt = null

    try {
      nextRunAt = nextRunAfter(
        task,
        Date.now()
      )
    } catch {
      nextRunAt = null
    }

    finishRun(
      runId,
      'failed',
      null,
      error?.message || String(error),
      finishedAt
    )

    failTask(task, finishedAt, nextRunAt)

    console.error(JSON.stringify({
      level: 'error',
      event: 'scheduled_task_failed',
      taskId: task.id,
      userId: task.user_id,
      error: error?.message || String(error),
      nextRunAt
    }))
  }
}

async function tick() {
  if (ticking || stopping) return

  ticking = true

  try {
    const now = Math.floor(Date.now() / 1000)

    for (
      let count = 0;
      count < MAX_TASKS_PER_TICK;
      count++
    ) {
      const task = claimNextTask(now)

      if (!task) break

      await processTask(task)
    }
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      event: 'task_worker_tick_failed',
      error: error?.message || String(error)
    }))
  } finally {
    ticking = false
  }
}

function shutdown(signal) {
  stopping = true

  console.log(JSON.stringify({
    level: 'info',
    event: 'task_worker_stopping',
    signal
  }))

  setTimeout(() => {
    try {
      db.close()
    } catch {}

    process.exit(0)
  }, ticking ? 1_000 : 0)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

console.log(JSON.stringify({
  level: 'info',
  event: 'task_worker_started',
  pollMs: POLL_MS
}))

tick()
setInterval(tick, POLL_MS)
