import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import db from '../db.js'
import {
  createDedicatedTaskConversation,
  getOwnedConversation
} from '../lib/taskConversations.js'
import {
  DEFAULT_TASK_TIMEZONE,
  normalizeSchedule
} from '../lib/scheduler.js'

const router = Router()

const LIMITS = {
  title: 160,
  prompt: 20_000,
  retentionDays: 3650
}

function taskToJson(task) {
  return {
    id: task.id,
    type: task.task_type,
    conversationId: task.conversation_id,
    conversationTitle: task.conversation_title || null,
    title: task.title,
    prompt: task.prompt,
    scheduleKind: task.schedule_kind,
    scheduleValue: task.schedule_value,
    timezone: task.timezone,
    retentionDays: task.retention_days ?? null,
    enabled: Boolean(task.enabled),
    nextRunAt: task.next_run_at,
    lastRunAt: task.last_run_at,
    createdAt: task.created_at,
    updatedAt: task.updated_at,
    lastRunStatus: task.last_run_status || null,
    lastRunError: task.last_run_error || null,
    lastRunStartedAt:
      task.last_run_started_at || null,
    lastRunFinishedAt:
      task.last_run_finished_at || null
  }
}

function getOwnedTask(userId, taskId) {
  return db.prepare(`
    SELECT
      task.*,
      conversation.title AS conversation_title
    FROM scheduled_tasks AS task
    LEFT JOIN conversations AS conversation
      ON conversation.id = task.conversation_id
    WHERE task.id = ? AND task.user_id = ?
  `).get(taskId, userId)
}

function readText(value, name, maxLength) {
  if (typeof value !== 'string') {
    throw new Error(`${name} muss Text sein`)
  }

  const result = value.trim()

  if (!result) {
    throw new Error(`${name} darf nicht leer sein`)
  }

  if (result.length > maxLength) {
    throw new Error(
      `${name} ist zu lang, maximal ${maxLength} Zeichen`
    )
  }

  return result
}

function readTaskType(value, fallback = 'reminder') {
  const taskType = value === undefined
    ? fallback
    : String(value).trim()

  if (!['reminder', 'agent'].includes(taskType)) {
    throw new Error(
      'taskType muss reminder oder agent sein'
    )
  }

  return taskType
}

function readEnabled(value, fallback) {
  if (value === undefined) return fallback

  if (typeof value !== 'boolean') {
    throw new Error('enabled muss true oder false sein')
  }

  return value
}

function readRetentionDays(value, fallback = null) {
  if (value === undefined) return fallback

  if (value === null || String(value).trim() === '') {
    return null
  }

  const days = Number(value)

  if (
    !Number.isInteger(days) ||
    days < 1 ||
    days > LIMITS.retentionDays
  ) {
    throw new Error(
      `Aufbewahrung muss zwischen 1 und ${LIMITS.retentionDays} Tagen liegen`
    )
  }

  return days
}

router.get('/', requireAuth, (req, res) => {
  const tasks = db.prepare(`
    SELECT
      task.*,
      conversation.title AS conversation_title,
      latest.status AS last_run_status,
      latest.error AS last_run_error,
      latest.started_at AS last_run_started_at,
      latest.finished_at AS last_run_finished_at
    FROM scheduled_tasks AS task
    LEFT JOIN conversations AS conversation
      ON conversation.id = task.conversation_id
    LEFT JOIN task_runs AS latest
      ON latest.id = (
        SELECT run.id
        FROM task_runs AS run
        WHERE run.task_id = task.id
        ORDER BY run.id DESC
        LIMIT 1
      )
    WHERE task.user_id = ?
    ORDER BY
      task.enabled DESC,
      task.next_run_at ASC,
      task.id DESC
  `).all(req.session.userId)

  res.json(tasks.map(taskToJson))
})

router.get('/:id/runs', requireAuth, (req, res) => {
  const task = getOwnedTask(
    req.session.userId,
    Number(req.params.id)
  )

  if (!task) {
    return res.status(404).json({
      error: 'Task nicht gefunden'
    })
  }

  const runs = db.prepare(`
    SELECT
      id,
      status,
      result,
      error,
      started_at AS startedAt,
      finished_at AS finishedAt
    FROM task_runs
    WHERE task_id = ?
    ORDER BY id DESC
    LIMIT 50
  `).all(task.id)

  res.json(runs)
})

router.post('/', requireAuth, (req, res) => {
  try {
    const title = readText(
      req.body?.title,
      'Titel',
      LIMITS.title
    )

    const prompt = readText(
      req.body?.prompt,
      'Prompt',
      LIMITS.prompt
    )

    const taskType = readTaskType(
      req.body?.taskType ?? req.body?.type
    )

    const conversationMode =
      req.body?.conversationMode === 'auto' ||
      req.body?.conversationId === undefined ||
      req.body?.conversationId === null
        ? 'auto'
        : 'existing'

    let conversationId = Number(
      req.body?.conversationId
    )

    if (conversationMode === 'auto') {
      const dedicated = createDedicatedTaskConversation({
        userId: req.session.userId,
        title,
        templateConversationId:
          req.body?.templateConversationId ??
          req.body?.conversationId
      })

      conversationId = dedicated.id
    } else if (
      !getOwnedConversation(
        req.session.userId,
        conversationId
      )
    ) {
      return res.status(400).json({
        error: 'Ungültige Unterhaltung'
      })
    }

    const schedule = normalizeSchedule({
      scheduleKind: req.body?.scheduleKind,
      scheduleValue: req.body?.scheduleValue,
      timezone:
        req.body?.timezone || DEFAULT_TASK_TIMEZONE
    })

    const enabled = readEnabled(
      req.body?.enabled,
      true
    )

    const retentionDays = readRetentionDays(
      req.body?.retentionDays,
      null
    )

    const result = db.prepare(`
      INSERT INTO scheduled_tasks (
        user_id,
        conversation_id,
        task_type,
        title,
        prompt,
        schedule_kind,
        schedule_value,
        timezone,
        retention_days,
        enabled,
        next_run_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.session.userId,
      conversationId,
      taskType,
      title,
      prompt,
      schedule.scheduleKind,
      schedule.scheduleValue,
      schedule.timezone,
      retentionDays,
      enabled ? 1 : 0,
      enabled ? schedule.nextRunAt : null
    )

    const task = getOwnedTask(
      req.session.userId,
      Number(result.lastInsertRowid)
    )

    res.status(201).json(taskToJson(task))
  } catch (error) {
    res.status(400).json({
      error: error?.message || String(error)
    })
  }
})

router.patch('/:id', requireAuth, (req, res) => {
  const taskId = Number(req.params.id)
  const existing = getOwnedTask(
    req.session.userId,
    taskId
  )

  if (!existing) {
    return res.status(404).json({
      error: 'Task nicht gefunden'
    })
  }

  try {
    const title = req.body?.title === undefined
      ? existing.title
      : readText(
          req.body.title,
          'Titel',
          LIMITS.title
        )

    const prompt = req.body?.prompt === undefined
      ? existing.prompt
      : readText(
          req.body.prompt,
          'Prompt',
          LIMITS.prompt
        )

    const taskType = readTaskType(
      req.body?.taskType ?? req.body?.type,
      existing.task_type
    )

    let conversationId = existing.conversation_id

    if (req.body?.conversationMode === 'auto') {
      const dedicated = createDedicatedTaskConversation({
        userId: req.session.userId,
        title,
        templateConversationId:
          req.body?.templateConversationId ??
          existing.conversation_id
      })

      conversationId = dedicated.id
    } else if (req.body?.conversationId !== undefined) {
      conversationId = Number(req.body.conversationId)

      if (
        !getOwnedConversation(
          req.session.userId,
          conversationId
        )
      ) {
        return res.status(400).json({
          error: 'Ungültige Unterhaltung'
        })
      }
    }

    const scheduleChanged = [
      'scheduleKind',
      'scheduleValue',
      'timezone'
    ].some(key => req.body?.[key] !== undefined)

    const enabled = readEnabled(
      req.body?.enabled,
      Boolean(existing.enabled)
    )

    let scheduleKind = existing.schedule_kind
    let scheduleValue = existing.schedule_value
    let timezone = existing.timezone
    let nextRunAt = existing.next_run_at

    if (
      scheduleChanged ||
      (enabled && !existing.enabled)
    ) {
      const schedule = normalizeSchedule({
        scheduleKind:
          req.body?.scheduleKind ??
          existing.schedule_kind,
        scheduleValue:
          req.body?.scheduleValue ??
          existing.schedule_value,
        timezone:
          req.body?.timezone ??
          existing.timezone
      })

      scheduleKind = schedule.scheduleKind
      scheduleValue = schedule.scheduleValue
      timezone = schedule.timezone
      nextRunAt = schedule.nextRunAt
    }

    if (!enabled) {
      nextRunAt = null
    }

    const retentionDays = readRetentionDays(
      req.body?.retentionDays,
      existing.retention_days ?? null
    )

    db.prepare(`
      UPDATE scheduled_tasks
      SET
        conversation_id = ?,
        task_type = ?,
        title = ?,
        prompt = ?,
        schedule_kind = ?,
        schedule_value = ?,
        timezone = ?,
        retention_days = ?,
        enabled = ?,
        next_run_at = ?,
        locked_at = NULL,
        updated_at = unixepoch()
      WHERE id = ? AND user_id = ?
    `).run(
      conversationId,
      taskType,
      title,
      prompt,
      scheduleKind,
      scheduleValue,
      timezone,
      retentionDays,
      enabled ? 1 : 0,
      nextRunAt,
      taskId,
      req.session.userId
    )

    res.json(
      taskToJson(
        getOwnedTask(req.session.userId, taskId)
      )
    )
  } catch (error) {
    res.status(400).json({
      error: error?.message || String(error)
    })
  }
})

router.post('/:id/run-now', requireAuth, (req, res) => {
  const taskId = Number(req.params.id)

  const result = db.prepare(`
    UPDATE scheduled_tasks
    SET
      enabled = 1,
      next_run_at = unixepoch(),
      locked_at = NULL,
      updated_at = unixepoch()
    WHERE id = ? AND user_id = ?
  `).run(taskId, req.session.userId)

  if (!result.changes) {
    return res.status(404).json({
      error: 'Task nicht gefunden'
    })
  }

  res.json({
    ok: true,
    task: taskToJson(
      getOwnedTask(req.session.userId, taskId)
    )
  })
})

router.delete('/:id', requireAuth, (req, res) => {
  const result = db.prepare(`
    DELETE FROM scheduled_tasks
    WHERE id = ? AND user_id = ?
  `).run(
    Number(req.params.id),
    req.session.userId
  )

  if (!result.changes) {
    return res.status(404).json({
      error: 'Task nicht gefunden'
    })
  }

  res.json({ ok: true })
})

export default router
