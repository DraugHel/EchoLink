import db from '../db.js'
import {
  createDedicatedTaskConversation
} from './taskConversations.js'
import {
  DEFAULT_TASK_TIMEZONE,
  normalizeSchedule
} from './scheduler.js'

const MAX_TITLE_LENGTH = 160
const MAX_PROMPT_LENGTH = 20_000

export const TASK_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'create_task',
      description:
        'Create a scheduled reminder or recurring task. ' +
        'Use taskType reminder for static text that should simply be shown later. ' +
        'Use taskType agent when EchoLink must generate fresh content at run time, for example news briefings, weather reports, pollen reports, inbox summaries, or other tasks that require current information and tools. Agent tasks automatically receive their own dedicated conversation. ' +
        'Requests such as "in 2 minutes", "tomorrow", or "at 15:00" MUST use once. ' +
        'Use interval or cron only when the user explicitly asks for repetition, such as "every 2 minutes" or "jeden Montag". ' +
        'For once, scheduleValue must be an ISO 8601 timestamp including an offset, for example 2026-07-14T15:00:00+02:00. ' +
        'Default timezone is Europe/Vienna.',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Short descriptive task title'
          },
          prompt: {
            type: 'string',
            description:
              'For reminder: the text to display. For agent: the complete instruction the model should execute when the task runs.'
          },
          taskType: {
            type: 'string',
            enum: ['reminder', 'agent'],
            description:
              'reminder = send static text; agent = generate a fresh answer with read-only web tools when the task runs. Defaults to reminder.'
          },
          scheduleKind: {
            type: 'string',
            enum: ['once', 'interval', 'cron'],
            description:
              'once = one specific timestamp, interval = every N minutes, cron = cron expression'
          },
          scheduleValue: {
            type: 'string',
            description:
              'ISO timestamp for once, integer minutes for interval, or a five-field cron expression'
          },
          recurring: {
            type: 'boolean',
            description:
              'False for one-time reminders. True only when repetition was explicitly requested.'
          },
          timezone: {
            type: 'string',
            description:
              'IANA timezone such as Europe/Vienna. Defaults to Europe/Vienna.'
          }
        },
        required: [
          'title',
          'prompt',
          'scheduleKind',
          'scheduleValue',
          'recurring'
        ]
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_tasks',
      description:
        'List the user’s scheduled reminders and recurring tasks.',
      parameters: {
        type: 'object',
        properties: {
          includeDisabled: {
            type: 'boolean',
            description:
              'Include disabled and completed one-time tasks. Defaults to false.'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_task',
      description:
        'Update, enable, or disable one of the user’s scheduled tasks. ' +
        'Only provide fields that should be changed.',
      parameters: {
        type: 'object',
        properties: {
          taskId: {
            type: 'integer',
            description: 'Numeric task ID'
          },
          title: {
            type: 'string'
          },
          prompt: {
            type: 'string'
          },
          taskType: {
            type: 'string',
            enum: ['reminder', 'agent']
          },
          scheduleKind: {
            type: 'string',
            enum: ['once', 'interval', 'cron']
          },
          scheduleValue: {
            type: 'string'
          },
          timezone: {
            type: 'string'
          },
          enabled: {
            type: 'boolean'
          }
        },
        required: ['taskId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_task',
      description:
        'Permanently delete one of the user’s scheduled tasks.',
      parameters: {
        type: 'object',
        properties: {
          taskId: {
            type: 'integer',
            description: 'Numeric task ID'
          }
        },
        required: ['taskId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_task_now',
      description:
        'Queue an existing scheduled task to run immediately.',
      parameters: {
        type: 'object',
        properties: {
          taskId: {
            type: 'integer',
            description: 'Numeric task ID'
          }
        },
        required: ['taskId']
      }
    }
  }
]

export const TASK_TOOL_NAMES = new Set(
  TASK_TOOLS.map(tool => tool.function.name)
)

function getContext(conversationId) {
  const id = Number(conversationId)

  if (!Number.isInteger(id) || id < 1) {
    throw new Error('Ungültige Unterhaltung')
  }

  const conversation = db.prepare(`
    SELECT id, user_id
    FROM conversations
    WHERE id = ?
  `).get(id)

  if (!conversation) {
    throw new Error('Unterhaltung nicht gefunden')
  }

  return {
    conversationId: conversation.id,
    userId: conversation.user_id
  }
}

function getOwnedTask(userId, taskId) {
  const id = Number(taskId)

  if (!Number.isInteger(id) || id < 1) {
    throw new Error('Ungültige Task-ID')
  }

  return db.prepare(`
    SELECT
      task.*,
      conversation.title AS conversation_title
    FROM scheduled_tasks AS task
    LEFT JOIN conversations AS conversation
      ON conversation.id = task.conversation_id
    WHERE task.id = ? AND task.user_id = ?
  `).get(id, userId)
}

function requireOwnedTask(userId, taskId) {
  const task = getOwnedTask(userId, taskId)

  if (!task) {
    throw new Error('Task nicht gefunden')
  }

  return task
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

function parseEnabled(value, fallback) {
  if (value === undefined) return fallback

  if (typeof value !== 'boolean') {
    throw new Error('enabled muss true oder false sein')
  }

  return value
}


function readTaskType(value, fallback = 'reminder') {
  const type = value === undefined
    ? fallback
    : String(value).trim()

  if (!['reminder', 'agent'].includes(type)) {
    throw new Error(
      'taskType muss reminder oder agent sein'
    )
  }

  return type
}

function unixToIso(value) {
  if (!value) return null

  return new Date(Number(value) * 1000).toISOString()
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
    enabled: Boolean(task.enabled),
    nextRunAt: task.next_run_at,
    nextRunAtIso: unixToIso(task.next_run_at),
    lastRunAt: task.last_run_at,
    lastRunAtIso: unixToIso(task.last_run_at)
  }
}

function resultJson(value) {
  return JSON.stringify(value, null, 2)
}

function createTask(args, context) {
  const title = readText(
    args.title,
    'Titel',
    MAX_TITLE_LENGTH
  )

  const prompt = readText(
    args.prompt,
    'Prompt',
    MAX_PROMPT_LENGTH
  )

  const taskType = readTaskType(args.taskType)

  if (typeof args.recurring !== 'boolean') {
    throw new Error('recurring muss true oder false sein')
  }

  if (args.scheduleKind === 'once' && args.recurring) {
    throw new Error(
      'Ein einmaliger Task darf nicht wiederkehrend sein'
    )
  }

  if (args.scheduleKind !== 'once' && !args.recurring) {
    throw new Error(
      'interval und cron sind nur für ausdrücklich wiederkehrende Tasks erlaubt'
    )
  }

  const schedule = normalizeSchedule({
    scheduleKind: args.scheduleKind,
    scheduleValue: args.scheduleValue,
    timezone:
      args.timezone || DEFAULT_TASK_TIMEZONE
  })

  const conversationId = taskType === 'agent'
    ? createDedicatedTaskConversation({
        userId: context.userId,
        title,
        templateConversationId:
          context.conversationId
      }).id
    : context.conversationId

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
      enabled,
      next_run_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(
    context.userId,
    conversationId,
    taskType,
    title,
    prompt,
    schedule.scheduleKind,
    schedule.scheduleValue,
    schedule.timezone,
    schedule.nextRunAt
  )

  const task = requireOwnedTask(
    context.userId,
    Number(result.lastInsertRowid)
  )

  return resultJson({
    ok: true,
    message: 'Task wurde erstellt',
    task: taskToJson(task)
  })
}

function listTasks(args, context) {
  const includeDisabled = args.includeDisabled === true

  const tasks = includeDisabled
    ? db.prepare(`
        SELECT *
        FROM scheduled_tasks
        WHERE user_id = ?
        ORDER BY enabled DESC, next_run_at ASC, id DESC
        LIMIT 100
      `).all(context.userId)
    : db.prepare(`
        SELECT *
        FROM scheduled_tasks
        WHERE user_id = ? AND enabled = 1
        ORDER BY next_run_at ASC, id DESC
        LIMIT 100
      `).all(context.userId)

  return resultJson({
    count: tasks.length,
    tasks: tasks.map(taskToJson)
  })
}

function updateTask(args, context) {
  const existing = requireOwnedTask(
    context.userId,
    args.taskId
  )

  const title = args.title === undefined
    ? existing.title
    : readText(
        args.title,
        'Titel',
        MAX_TITLE_LENGTH
      )

  const prompt = args.prompt === undefined
    ? existing.prompt
    : readText(
        args.prompt,
        'Prompt',
        MAX_PROMPT_LENGTH
      )

  const taskType = readTaskType(
    args.taskType,
    existing.task_type
  )

  const enabled = parseEnabled(
    args.enabled,
    Boolean(existing.enabled)
  )

  const scheduleChanged = [
    'scheduleKind',
    'scheduleValue',
    'timezone'
  ].some(key => args[key] !== undefined)

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
        args.scheduleKind ??
        existing.schedule_kind,
      scheduleValue:
        args.scheduleValue ??
        existing.schedule_value,
      timezone:
        args.timezone ??
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

  db.prepare(`
    UPDATE scheduled_tasks
    SET
      task_type = ?,
      title = ?,
      prompt = ?,
      schedule_kind = ?,
      schedule_value = ?,
      timezone = ?,
      enabled = ?,
      next_run_at = ?,
      locked_at = NULL,
      updated_at = unixepoch()
    WHERE id = ? AND user_id = ?
  `).run(
    taskType,
    title,
    prompt,
    scheduleKind,
    scheduleValue,
    timezone,
    enabled ? 1 : 0,
    nextRunAt,
    existing.id,
    context.userId
  )

  const updated = requireOwnedTask(
    context.userId,
    existing.id
  )

  return resultJson({
    ok: true,
    message: 'Task wurde aktualisiert',
    task: taskToJson(updated)
  })
}

function deleteTask(args, context) {
  const existing = requireOwnedTask(
    context.userId,
    args.taskId
  )

  db.prepare(`
    DELETE FROM scheduled_tasks
    WHERE id = ? AND user_id = ?
  `).run(existing.id, context.userId)

  return resultJson({
    ok: true,
    message: 'Task wurde gelöscht',
    deletedTaskId: existing.id
  })
}

function runTaskNow(args, context) {
  const existing = requireOwnedTask(
    context.userId,
    args.taskId
  )

  db.prepare(`
    UPDATE scheduled_tasks
    SET
      enabled = 1,
      next_run_at = unixepoch(),
      locked_at = NULL,
      updated_at = unixepoch()
    WHERE id = ? AND user_id = ?
  `).run(existing.id, context.userId)

  return resultJson({
    ok: true,
    message:
      'Task wurde zur sofortigen Ausführung vorgemerkt',
    taskId: existing.id
  })
}

export async function executeTaskTool(
  name,
  args,
  conversationId
) {
  const context = getContext(conversationId)
  const safeArgs =
    args && typeof args === 'object' ? args : {}

  switch (name) {
    case 'create_task':
      return createTask(safeArgs, context)

    case 'list_tasks':
      return listTasks(safeArgs, context)

    case 'update_task':
      return updateTask(safeArgs, context)

    case 'delete_task':
      return deleteTask(safeArgs, context)

    case 'run_task_now':
      return runTaskNow(safeArgs, context)

    default:
      throw new Error(`Unbekanntes Task-Tool: ${name}`)
  }
}
