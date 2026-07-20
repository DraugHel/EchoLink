import './loadEnv.js'
import db from './db.js'
import { computeNextRunAt } from './lib/scheduler.js'
import { sendPushToUser } from './lib/push.js'
import {
  AgentRunCancelledError,
  runScheduledAgent
} from './lib/agentRunner.js'
import {
  createDedicatedTaskConversation
} from './lib/taskConversations.js'
import {
  cleanupScheduledTasks
} from './lib/taskCleanup.js'
import {
  appendTaskRunEvent,
  createTaskRun,
  defaultAgentPlan,
  finishTaskRun,
  readTaskRunControl,
  updateTaskRun
} from './lib/taskRunState.js'

const POLL_MS = Math.max(
  5_000,
  Number(process.env.TASK_POLL_MS) || 30_000
)

const LOCK_TIMEOUT_SECONDS = 5 * 60
const MAX_TASKS_PER_TICK = 25

let ticking = false
let stopping = false

function recoverInterruptedRuns() {
  const now = Math.floor(Date.now() / 1000)

  const recover = db.transaction(() => {
    const runs = db.prepare(`
      SELECT id, task_id
      FROM task_runs
      WHERE status = 'running'
    `).all()

    if (!runs.length) return 0

    const finish = db.prepare(`
      UPDATE task_runs
      SET
        status = 'failed',
        phase = 'interrupted',
        progress = 'Worker wurde während des Runs neu gestartet',
        control_state = 'finished',
        error = 'Agentenlauf wurde durch einen Worker-Neustart unterbrochen',
        finished_at = ?,
        updated_at = ?
      WHERE id = ? AND status = 'running'
    `)

    const clearLock = db.prepare(`
      UPDATE scheduled_tasks
      SET locked_at = NULL, updated_at = ?
      WHERE id = ?
    `)

    let recovered = 0

    for (const run of runs) {
      const result = finish.run(now, now, run.id)
      if (!result.changes) continue

      clearLock.run(now, run.task_id)
      appendTaskRunEvent(db, run.id, {
        type: 'interrupted',
        message: 'Run wurde durch einen Worker-Neustart unterbrochen',
        createdAt: now
      })
      recovered++
    }

    return recovered
  })

  const recovered = recover()

  if (recovered > 0) {
    console.warn(JSON.stringify({
      level: 'warn',
      event: 'task_runs_recovered_after_restart',
      recovered
    }))
  }
}

recoverInterruptedRuns()

const TASK_ONCE_RETENTION_DAYS = Math.max(
  1,
  Number(process.env.TASK_ONCE_RETENTION_DAYS) || 30
)

const TASK_RUN_RETENTION_DAYS = Math.max(
  1,
  Number(process.env.TASK_RUN_RETENTION_DAYS) || 90
)

const TASK_CLEANUP_INTERVAL_MS = Math.max(
  60 * 60 * 1000,
  (
    Number(
      process.env.TASK_CLEANUP_INTERVAL_HOURS
    ) || 24
  ) * 60 * 60 * 1000
)

function runTaskCleanup() {
  try {
    const result = cleanupScheduledTasks(db, {
      onceRetentionDays:
        TASK_ONCE_RETENTION_DAYS,
      runRetentionDays:
        TASK_RUN_RETENTION_DAYS
    })

    console.log(JSON.stringify({
      level: 'info',
      event: 'scheduled_task_cleanup',
      deletedTasks: result.deletedTasks,
      deletedRuns: result.deletedRuns
    }))
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      event: 'scheduled_task_cleanup_failed',
      error: error?.message || String(error)
    }))
  }
}

runTaskCleanup()

const taskCleanupTimer = setInterval(
  runTaskCleanup,
  TASK_CLEANUP_INTERVAL_MS
)

taskCleanupTimer.unref?.()

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

function resolveTaskConversation(task) {
  let conversation = db.prepare(`
    SELECT
      id,
      user_id,
      model,
      temperature,
      top_k,
      top_p,
      reasoning_effort
    FROM conversations
    WHERE id = ? AND user_id = ?
  `).get(
    task.conversation_id,
    task.user_id
  )

  if (conversation) {
    return conversation
  }

  conversation = createDedicatedTaskConversation({
    userId: task.user_id,
    title: task.title,
    templateConversationId: null
  })

  db.prepare(`
    UPDATE scheduled_tasks
    SET
      conversation_id = ?,
      updated_at = unixepoch()
    WHERE id = ? AND user_id = ?
  `).run(
    conversation.id,
    task.id,
    task.user_id
  )

  console.log(JSON.stringify({
    level: 'warn',
    event: 'scheduled_task_conversation_recreated',
    taskId: task.id,
    userId: task.user_id,
    conversationId: conversation.id
  }))

  return conversation
}

async function executeReminder(task) {
  const conversation = resolveTaskConversation(task)

  const content = [
    `**Erinnerung: ${task.title}**`,
    '',
    task.prompt
  ].join('\n')

  db.prepare(`
    INSERT INTO messages (
      conversation_id,
      role,
      content,
      source_task_id
    )
    VALUES (?, 'assistant', ?, ?)
  `).run(
    conversation.id,
    content,
    task.id
  )

  db.prepare(`
    UPDATE conversations
    SET updated_at = unixepoch()
    WHERE id = ?
  `).run(conversation.id)

  pruneTaskMessages(task, conversation.id)

  const pushResult = await sendPushToUser(
    task.user_id,
    {
      title: `Erinnerung: ${task.title}`,
      body: task.prompt,
      url: `/?conversation=${conversation.id}`,
      tag: `echolink-task-${task.id}`,
      conversationId: conversation.id
    }
  )

  console.log(JSON.stringify({
    level: 'info',
    event: 'scheduled_task_push',
    taskId: task.id,
    userId: task.user_id,
    sent: pushResult.sent,
    failed: pushResult.failed,
    removed: pushResult.removed
  }))

  return content
}

function pruneTaskMessages(task, conversationId) {
  const retentionDays = Number(task.retention_days)

  if (
    !Number.isInteger(retentionDays) ||
    retentionDays < 1
  ) {
    return
  }

  try {
    const cutoff = Math.floor(Date.now() / 1000) -
      retentionDays * 24 * 60 * 60

    const result = db.prepare(`
      DELETE FROM messages
      WHERE
        source_task_id = ?
        AND conversation_id = ?
        AND created_at < ?
    `).run(task.id, conversationId, cutoff)

    if (result.changes > 0) {
      console.log(JSON.stringify({
        level: 'info',
        event: 'scheduled_task_messages_pruned',
        taskId: task.id,
        conversationId,
        retentionDays,
        deletedMessages: result.changes
      }))
    }
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      event: 'scheduled_task_message_prune_failed',
      taskId: task.id,
      conversationId,
      error: error?.message || String(error)
    }))
  }
}

function pushPreview(content) {
  const plain = String(content || '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[`*_>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  return plain.length > 240
    ? `${plain.slice(0, 237)}...`
    : plain
}

async function executeAgent(task, runId) {
  const conversation = resolveTaskConversation(task)
  const plan = defaultAgentPlan(task)

  updateTaskRun(db, runId, {
    phase: 'planning',
    plan,
    currentStep: 0,
    progress: 'Agentenplan wurde erstellt'
  })

  appendTaskRunEvent(db, runId, {
    type: 'plan',
    message: 'Agentenplan erstellt',
    detail: plan.map((step, index) =>
      `${index + 1}. ${step.title}`
    ).join('\n'),
    stepIndex: 0
  })

  const content = await runScheduledAgent({
    task,
    conversation,
    shouldCancel: () =>
      readTaskRunControl(db, runId) ===
      'cancel_requested',
    onProgress(event) {
      const stepIndex = Number.isInteger(event?.stepIndex)
        ? event.stepIndex
        : undefined

      updateTaskRun(db, runId, {
        phase: event?.phase,
        currentStep: stepIndex,
        progress: event?.message
      })

      appendTaskRunEvent(db, runId, {
        type: event?.type || 'progress',
        message: event?.message || '',
        detail: event?.detail || '',
        stepIndex
      })
    }
  })

  db.prepare(`
    INSERT INTO messages (
      conversation_id,
      role,
      content,
      source_task_id
    )
    VALUES (?, 'assistant', ?, ?)
  `).run(
    conversation.id,
    content,
    task.id
  )

  db.prepare(`
    UPDATE conversations
    SET updated_at = unixepoch()
    WHERE id = ?
  `).run(conversation.id)

  pruneTaskMessages(task, conversation.id)

  const pushResult = await sendPushToUser(
    task.user_id,
    {
      title: task.title,
      body: pushPreview(content),
      url: `/?conversation=${conversation.id}`,
      tag: `echolink-task-${task.id}`,
      conversationId: conversation.id
    }
  )

  console.log(JSON.stringify({
    level: 'info',
    event: 'scheduled_agent_push',
    taskId: task.id,
    userId: task.user_id,
    sent: pushResult.sent,
    failed: pushResult.failed,
    removed: pushResult.removed
  }))

  return content
}

async function executeTask(task, runId) {
  if (task.task_type === 'reminder') {
    return executeReminder(task)
  }

  if (task.task_type === 'agent') {
    return executeAgent(task, runId)
  }

  throw new Error(
    `Unbekannter Task-Typ: ${task.task_type}`
  )
}

async function processTask(task) {
  const startedAt = Math.floor(Date.now() / 1000)
  const initialPlan = task.task_type === 'agent'
    ? defaultAgentPlan(task)
    : []
  const runId = createTaskRun(
    db,
    task.id,
    startedAt,
    initialPlan
  )

  appendTaskRunEvent(db, runId, {
    type: 'started',
    message: task.task_type === 'agent'
      ? 'Agentenlauf gestartet'
      : 'Erinnerungslauf gestartet',
    stepIndex: 0,
    createdAt: startedAt
  })

  const lockHeartbeat = setInterval(() => {
    try {
      db.prepare(`
        UPDATE scheduled_tasks
        SET locked_at = unixepoch()
        WHERE id = ?
      `).run(task.id)
    } catch {}
  }, 30_000)

  lockHeartbeat.unref?.()

  try {
    const result = await executeTask(task, runId)
    const finishedAt = Math.floor(Date.now() / 1000)

    const nextRunAt = nextRunAfter(
      task,
      Date.now()
    )

    finishTaskRun(db, runId, {
      status: 'success',
      phase: 'success',
      result,
      finishedAt
    })

    appendTaskRunEvent(db, runId, {
      type: 'completed',
      message: 'Run erfolgreich abgeschlossen',
      stepIndex: initialPlan.length
        ? initialPlan.length - 1
        : 0,
      createdAt: finishedAt
    })

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

    const cancelled =
      error instanceof AgentRunCancelledError

    finishTaskRun(db, runId, {
      status: 'failed',
      phase: cancelled ? 'cancelled' : 'failed',
      error: cancelled
        ? null
        : error?.message || String(error),
      controlState: cancelled
        ? 'cancelled'
        : 'finished',
      finishedAt
    })

    appendTaskRunEvent(db, runId, {
      type: cancelled ? 'cancelled' : 'failed',
      message: cancelled
        ? 'Run wurde abgebrochen'
        : 'Run ist fehlgeschlagen',
      detail: cancelled
        ? ''
        : error?.message || String(error),
      createdAt: finishedAt
    })

    failTask(task, finishedAt, nextRunAt)

    console.error(JSON.stringify({
      level: cancelled ? 'info' : 'error',
      event: cancelled
        ? 'scheduled_task_cancelled'
        : 'scheduled_task_failed',
      taskId: task.id,
      userId: task.user_id,
      error: cancelled
        ? null
        : error?.message || String(error),
      nextRunAt
    }))
  } finally {
    clearInterval(lockHeartbeat)
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
