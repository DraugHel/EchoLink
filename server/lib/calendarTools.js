import db from '../db.js'
import {
  createCalendarEvent,
  listCalendarEvents
} from '../connectors/google/calendar.js'

export const CALENDAR_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'calendar_list_events',
      description:
        'Read events from the user’s primary Google Calendar. ' +
        'Use this for questions about appointments, meetings, today, tomorrow, ' +
        'this week, or the next event. Calculate explicit ISO timestamps.',
      parameters: {
        type: 'object',
        properties: {
          timeMin: {
            type: 'string',
            description:
              'Start as ISO 8601 including timezone offset.'
          },
          timeMax: {
            type: 'string',
            description:
              'End as ISO 8601 including timezone offset.'
          },
          maxResults: {
            type: 'integer',
            minimum: 1,
            maximum: 50
          },
          timeZone: {
            type: 'string',
            description:
              'IANA timezone. Default Europe/Vienna.'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'calendar_create_event',
      description:
        'Create a pending Google Calendar event approval request. ' +
        'When the user explicitly asks to create, add, or schedule an event and title, start, and end are known, call this tool immediately. ' +
        'Do NOT ask the user to confirm by replying yes; the application displays its own Approve and Deny buttons. ' +
        'Only ask a follow-up question when a required title, date, start time, or end time is genuinely missing. ' +
        'Use ISO 8601 timestamps including an offset. Default timezone is Europe/Vienna.',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Event title'
          },
          start: {
            type: 'string',
            description:
              'Event start as ISO 8601 timestamp including offset.'
          },
          end: {
            type: 'string',
            description:
              'Event end as ISO 8601 timestamp including offset.'
          },
          timeZone: {
            type: 'string',
            description:
              'IANA timezone. Default Europe/Vienna.'
          },
          location: {
            type: 'string',
            description: 'Optional event location'
          },
          description: {
            type: 'string',
            description: 'Optional event description'
          }
        },
        required: [
          'title',
          'start',
          'end'
        ]
      }
    }
  }
]

export const CALENDAR_TOOL_NAMES = new Set(
  CALENDAR_TOOLS.map(tool => tool.function.name)
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

function requiredText(
  value,
  name,
  maxLength
) {
  if (typeof value !== 'string') {
    throw new Error(`${name} muss Text sein`)
  }

  const result = value.trim()

  if (!result) {
    throw new Error(`${name} darf nicht leer sein`)
  }

  if (result.length > maxLength) {
    throw new Error(`${name} ist zu lang`)
  }

  return result
}

function optionalText(value, maxLength) {
  if (value == null || value === '') return ''

  if (typeof value !== 'string') {
    throw new Error('Ungültiger Textwert')
  }

  return value.trim().slice(0, maxLength)
}

function validDate(value, name) {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    throw new Error(
      `${name} ist kein gültiger ISO-Zeitpunkt`
    )
  }

  return date
}

export function prepareCalendarCreateEvent(
  args = {}
) {
  const startDate = validDate(
    args.start,
    'Beginn'
  )

  const endDate = validDate(
    args.end,
    'Ende'
  )

  if (endDate <= startDate) {
    throw new Error(
      'Das Terminende muss nach dem Beginn liegen'
    )
  }

  const timeZone =
    optionalText(args.timeZone, 100) ||
    'Europe/Vienna'

  try {
    new Intl.DateTimeFormat('de-AT', {
      timeZone
    }).format(startDate)
  } catch {
    throw new Error(
      `Ungültige Zeitzone: ${timeZone}`
    )
  }

  return {
    title: requiredText(
      args.title,
      'Titel',
      300
    ),
    start: startDate.toISOString(),
    end: endDate.toISOString(),
    timeZone,
    location: optionalText(
      args.location,
      1000
    ),
    description: optionalText(
      args.description,
      8000
    )
  }
}

function displayDate(value, timeZone) {
  return new Intl.DateTimeFormat('de-AT', {
    timeZone,
    dateStyle: 'full',
    timeStyle: 'short'
  }).format(new Date(value))
}

export function formatCalendarCreatePreview(
  event
) {
  return [
    `Titel: ${event.title}`,
    `Beginn: ${displayDate(
      event.start,
      event.timeZone
    )}`,
    `Ende: ${displayDate(
      event.end,
      event.timeZone
    )}`,
    `Zeitzone: ${event.timeZone}`,
    event.location
      ? `Ort: ${event.location}`
      : null,
    event.description
      ? `Beschreibung: ${event.description}`
      : null
  ].filter(Boolean).join('\n')
}

export async function executeCalendarTool(
  name,
  args,
  conversationId
) {
  if (!CALENDAR_TOOL_NAMES.has(name)) {
    throw new Error(
      `Unbekanntes Kalender-Tool: ${name}`
    )
  }

  const context = getContext(conversationId)

  if (name === 'calendar_list_events') {
    const result = await listCalendarEvents(
      context.userId,
      {
        timeMin: args?.timeMin,
        timeMax: args?.timeMax,
        maxResults: args?.maxResults,
        timeZone:
          args?.timeZone || 'Europe/Vienna'
      }
    )

    return JSON.stringify({
      count: result.events.length,
      timeMin: result.timeMin,
      timeMax: result.timeMax,
      timeZone: result.timeZone,
      events: result.events
    }, null, 2)
  }

  const event =
    prepareCalendarCreateEvent(args)

  const created = await createCalendarEvent(
    context.userId,
    event
  )

  return JSON.stringify({
    created: true,
    event: created
  }, null, 2)
}
