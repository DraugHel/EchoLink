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
        'For timed events provide title, start, and end as ISO 8601 timestamps. ' +
        'For all-day events set allDay=true and provide startDate and endDate as YYYY-MM-DD; endDate is the final included day. ' +
        'For a one-day all-day event, startDate and endDate are identical. ' +
        'Call this tool immediately when the required information is known. ' +
        'Do NOT ask the user to confirm by replying yes; EchoLink displays Approve and Deny buttons.',
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
          allDay: {
            type: 'boolean',
            description:
              'True for an all-day event.'
          },
          startDate: {
            type: 'string',
            description:
              'First included day as YYYY-MM-DD for an all-day event.'
          },
          endDate: {
            type: 'string',
            description:
              'Final included day as YYYY-MM-DD for an all-day event.'
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
          'title'
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

function validDateOnly(value, name) {
  const result = String(value || '').trim()

  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) {
    throw new Error(
      `${name} muss YYYY-MM-DD entsprechen`
    )
  }

  const [year, month, day] =
    result.split('-').map(Number)

  const date = new Date(
    Date.UTC(year, month - 1, day)
  )

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(
      `${name} ist kein gültiges Datum`
    )
  }

  return result
}

export function prepareCalendarCreateEvent(
  args = {}
) {
  const timeZone =
    optionalText(args.timeZone, 100) ||
    'Europe/Vienna'

  try {
    new Intl.DateTimeFormat('de-AT', {
      timeZone
    }).format(new Date())
  } catch {
    throw new Error(
      `Ungültige Zeitzone: ${timeZone}`
    )
  }

  const common = {
    title: requiredText(
      args.title,
      'Titel',
      300
    ),
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

  if (args.allDay === true) {
    const startDate = validDateOnly(
      args.startDate,
      'Startdatum'
    )

    const endDate = validDateOnly(
      args.endDate || args.startDate,
      'Enddatum'
    )

    if (endDate < startDate) {
      throw new Error(
        'Das Enddatum darf nicht vor dem Startdatum liegen'
      )
    }

    return {
      ...common,
      allDay: true,
      startDate,
      endDate
    }
  }

  const startDateTime = validDate(
    args.start,
    'Beginn'
  )

  const endDateTime = validDate(
    args.end,
    'Ende'
  )

  if (endDateTime <= startDateTime) {
    throw new Error(
      'Das Terminende muss nach dem Beginn liegen'
    )
  }

  return {
    ...common,
    allDay: false,
    start: startDateTime.toISOString(),
    end: endDateTime.toISOString()
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
  if (event.allDay) {
    return [
      `Titel: ${event.title}`,
      event.startDate === event.endDate
        ? `Ganztägig am: ${event.startDate}`
        : `Ganztägig: ${event.startDate} bis ${event.endDate}`,
      event.location
        ? `Ort: ${event.location}`
        : null,
      event.description
        ? `Beschreibung: ${event.description}`
        : null
    ].filter(Boolean).join('\n')
  }

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
