import db from '../db.js'
import {
  deleteCalendarEvent,
  getCalendarBusy,
  getCalendarEvent,
  updateCalendarEvent
} from '../connectors/google/calendarExtra.js'

export const CALENDAR_EXTRA_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'calendar_get_event',
      description:
        'Read one Google Calendar event by its event ID. ' +
        'Use calendar_list_events first when the ID is unknown.',
      parameters: {
        type: 'object',
        properties: {
          eventId: {
            type: 'string',
            description: 'Google Calendar event ID'
          }
        },
        required: ['eventId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'calendar_update_event',
      description:
        'Prepare changes to an existing Google Calendar event. ' +
        'Use calendar_list_events first to identify the exact event. ' +
        'For all-day events use startDate and endDate as YYYY-MM-DD; endDate is the final included day. ' +
        'Omit allDay to preserve the existing event type. ' +
        'Call this immediately when the requested change is unambiguous. ' +
        'Do not ask for a textual yes; EchoLink shows Approve and Deny buttons.',
      parameters: {
        type: 'object',
        properties: {
          eventId: {
            type: 'string'
          },
          allDay: {
            type: 'boolean',
            description:
              'Desired event type. Omit to preserve the current type.'
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
          title: {
            type: 'string'
          },
          start: {
            type: 'string',
            description:
              'New start as ISO 8601 including timezone offset'
          },
          end: {
            type: 'string',
            description:
              'New end as ISO 8601 including timezone offset'
          },
          timeZone: {
            type: 'string'
          },
          location: {
            type: 'string',
            description:
              'New location. Empty string removes it.'
          },
          description: {
            type: 'string',
            description:
              'New description. Empty string removes it.'
          }
        },
        required: ['eventId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'calendar_delete_event',
      description:
        'Prepare deletion of an existing Google Calendar event. ' +
        'Use calendar_list_events first to identify the exact event. ' +
        'Do not ask for a textual yes; EchoLink shows Approve and Deny buttons.',
      parameters: {
        type: 'object',
        properties: {
          eventId: {
            type: 'string'
          }
        },
        required: ['eventId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'calendar_find_free_time',
      description:
        'Find free windows in the user’s primary Google Calendar. ' +
        'Use exact ISO timestamps for the requested search period.',
      parameters: {
        type: 'object',
        properties: {
          timeMin: {
            type: 'string'
          },
          timeMax: {
            type: 'string'
          },
          durationMinutes: {
            type: 'integer',
            minimum: 1,
            maximum: 1440,
            description:
              'Minimum free duration. Defaults to 30 minutes.'
          },
          timeZone: {
            type: 'string',
            description:
              'IANA timezone. Defaults to Europe/Vienna.'
          }
        },
        required: [
          'timeMin',
          'timeMax'
        ]
      }
    }
  }
]

export const CALENDAR_EXTRA_TOOL_NAMES = new Set(
  CALENDAR_EXTRA_TOOLS.map(
    tool => tool.function.name
  )
)

export const CALENDAR_EXTRA_WRITE_NAMES = new Set([
  'calendar_update_event',
  'calendar_delete_event'
])

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

function has(object, key) {
  return Object.prototype.hasOwnProperty.call(
    object || {},
    key
  )
}

function requireEventId(value) {
  const eventId = String(value || '').trim()

  if (!eventId) {
    throw new Error('Kalendertermin-ID fehlt')
  }

  return eventId
}

function requiredText(value, name) {
  const result = String(value || '').trim()

  if (!result) {
    throw new Error(`${name} darf nicht leer sein`)
  }

  return result
}

function optionalText(value, maxLength) {
  if (value == null) return ''

  if (typeof value !== 'string') {
    throw new Error('Kalenderwert muss Text sein')
  }

  return value.trim().slice(0, maxLength)
}

function parseDate(value, name) {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    throw new Error(
      `${name} ist kein gültiger Zeitpunkt`
    )
  }

  return date
}

function validateTimeZone(value) {
  const timeZone =
    String(value || 'Europe/Vienna').trim()

  try {
    new Intl.DateTimeFormat('de-AT', {
      timeZone
    }).format(new Date())
  } catch {
    throw new Error(
      `Ungültige Zeitzone: ${timeZone}`
    )
  }

  return timeZone
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

function addDateOnlyDays(value, days) {
  const [year, month, day] =
    value.split('-').map(Number)

  const date = new Date(
    Date.UTC(year, month - 1, day + days)
  )

  return date.toISOString().slice(0, 10)
}

function dateOnlySpanDays(start, end) {
  const startMs =
    Date.parse(`${start}T00:00:00Z`)

  const endMs =
    Date.parse(`${end}T00:00:00Z`)

  return Math.max(
    0,
    Math.round(
      (endMs - startMs) / 86400_000
    )
  )
}

function displayDate(value, timeZone) {
  return new Intl.DateTimeFormat('de-AT', {
    timeZone,
    dateStyle: 'full',
    timeStyle: 'short'
  }).format(new Date(value))
}

function formatEvent(event) {
  if (event.allDay) {
    return [
      `Titel: ${event.title}`,
      `Ganztägig: ${event.start} bis ${event.end}`,
      event.location
        ? `Ort: ${event.location}`
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
    event.location
      ? `Ort: ${event.location}`
      : null,
    event.description
      ? `Beschreibung: ${event.description}`
      : null
  ].filter(Boolean).join('\n')
}

export function calendarExtraActionLabel(name) {
  if (name === 'calendar_update_event') {
    return 'Google-Kalendertermin ändern'
  }

  if (name === 'calendar_delete_event') {
    return 'Google-Kalendertermin löschen'
  }

  return 'Google-Kalenderaktion'
}

export async function prepareCalendarExtraAction(
  name,
  args,
  conversationId
) {
  const context = getContext(conversationId)
  const eventId = requireEventId(args?.eventId)

  const current = await getCalendarEvent(
    context.userId,
    eventId
  )

  if (name === 'calendar_delete_event') {
    return {
      kind: 'delete',
      eventId,
      etag: current.etag,
      event: current
    }
  }

  if (name !== 'calendar_update_event') {
    throw new Error(
      `Unbekannte Kalenderaktion: ${name}`
    )
  }

  const fields = [
    'title',
    'allDay',
    'start',
    'end',
    'startDate',
    'endDate',
    'timeZone',
    'location',
    'description'
  ]

  if (!fields.some(field => has(args, field))) {
    throw new Error(
      'Es wurde keine Terminänderung angegeben'
    )
  }

  if (
    has(args, 'allDay') &&
    typeof args.allDay !== 'boolean'
  ) {
    throw new Error(
      'allDay muss true oder false sein'
    )
  }

  const desiredAllDay = has(args, 'allDay')
    ? args.allDay
    : current.allDay

  const title = has(args, 'title')
    ? requiredText(args.title, 'Titel')
    : current.title

  const location = has(args, 'location')
    ? optionalText(args.location, 1000)
    : current.location

  const description = has(args, 'description')
    ? optionalText(args.description, 8000)
    : current.description

  let after

  if (desiredAllDay) {
    const oldStart =
      current.allDay
        ? current.startDate || current.start
        : ''

    const oldEnd =
      current.allDay
        ? current.endDate ||
          current.end ||
          oldStart
        : ''

    const startDate = has(args, 'startDate')
      ? validDateOnly(
          args.startDate,
          'Startdatum'
        )
      : oldStart
        ? validDateOnly(
            oldStart,
            'Startdatum'
          )
        : null

    if (!startDate) {
      throw new Error(
        'Für einen Ganztagstermin fehlt startDate'
      )
    }

    let endDate

    if (has(args, 'endDate')) {
      endDate = validDateOnly(
        args.endDate,
        'Enddatum'
      )
    } else if (
      has(args, 'startDate') &&
      oldStart &&
      oldEnd
    ) {
      const span = dateOnlySpanDays(
        oldStart,
        oldEnd
      )

      endDate = addDateOnlyDays(
        startDate,
        span
      )
    } else if (oldEnd) {
      endDate = validDateOnly(
        oldEnd,
        'Enddatum'
      )
    } else {
      endDate = startDate
    }

    if (endDate < startDate) {
      throw new Error(
        'Das Enddatum darf nicht vor dem Startdatum liegen'
      )
    }

    after = {
      ...current,
      title,
      allDay: true,
      start: startDate,
      end: endDate,
      startDate,
      endDate,
      location,
      description
    }
  } else {
    if (
      current.allDay &&
      (!has(args, 'start') || !has(args, 'end'))
    ) {
      throw new Error(
        'Für die Umwandlung in einen Zeit-Termin werden Beginn und Ende benötigt'
      )
    }

    const timeZone = validateTimeZone(
      has(args, 'timeZone')
        ? args.timeZone
        : current.timeZone
    )

    const start = has(args, 'start')
      ? parseDate(
          args.start,
          'Beginn'
        ).toISOString()
      : current.start

    const end = has(args, 'end')
      ? parseDate(
          args.end,
          'Ende'
        ).toISOString()
      : current.end

    if (new Date(end) <= new Date(start)) {
      throw new Error(
        'Das Terminende muss nach dem Beginn liegen'
      )
    }

    after = {
      ...current,
      title,
      allDay: false,
      start,
      end,
      startDate: null,
      endDate: null,
      timeZone,
      location,
      description
    }
  }

  return {
    kind: 'update',
    eventId,
    etag: current.etag,
    before: current,
    after
  }
}

export function formatCalendarExtraPreview(
  name,
  action
) {
  if (name === 'calendar_delete_event') {
    return [
      'Dieser Termin wird gelöscht:',
      '',
      formatEvent(action.event)
    ].join('\n')
  }

  return [
    'Bisher:',
    formatEvent(action.before),
    '',
    'Danach:',
    formatEvent(action.after)
  ].join('\n')
}

function mergeBusyRanges(
  busy,
  rangeStart,
  rangeEnd
) {
  const ranges = busy
    .map(item => ({
      start: Math.max(
        rangeStart,
        new Date(item.start).getTime()
      ),
      end: Math.min(
        rangeEnd,
        new Date(item.end).getTime()
      )
    }))
    .filter(item => item.end > item.start)
    .sort((a, b) => a.start - b.start)

  const merged = []

  for (const range of ranges) {
    const previous = merged.at(-1)

    if (
      previous &&
      range.start <= previous.end
    ) {
      previous.end = Math.max(
        previous.end,
        range.end
      )
    } else {
      merged.push({ ...range })
    }
  }

  return merged
}

function findFreeWindows(
  busy,
  rangeStart,
  rangeEnd,
  durationMs
) {
  const merged = mergeBusyRanges(
    busy,
    rangeStart,
    rangeEnd
  )

  const free = []
  let cursor = rangeStart

  for (const range of merged) {
    if (range.start - cursor >= durationMs) {
      free.push({
        start: new Date(cursor).toISOString(),
        end: new Date(range.start).toISOString(),
        durationMinutes:
          Math.floor(
            (range.start - cursor) / 60000
          )
      })
    }

    cursor = Math.max(cursor, range.end)
  }

  if (rangeEnd - cursor >= durationMs) {
    free.push({
      start: new Date(cursor).toISOString(),
      end: new Date(rangeEnd).toISOString(),
      durationMinutes:
        Math.floor(
          (rangeEnd - cursor) / 60000
        )
    })
  }

  return free
}

export async function executeCalendarExtraTool(
  name,
  args,
  conversationId
) {
  const context = getContext(conversationId)

  if (name === 'calendar_get_event') {
    const event = await getCalendarEvent(
      context.userId,
      requireEventId(args?.eventId)
    )

    return JSON.stringify({ event }, null, 2)
  }

  if (name === 'calendar_find_free_time') {
    const durationMinutes = Math.min(
      1440,
      Math.max(
        1,
        Number(args?.durationMinutes) || 30
      )
    )

    const busy = await getCalendarBusy(
      context.userId,
      {
        timeMin: args?.timeMin,
        timeMax: args?.timeMax,
        timeZone:
          args?.timeZone || 'Europe/Vienna'
      }
    )

    const rangeStart =
      new Date(busy.timeMin).getTime()

    const rangeEnd =
      new Date(busy.timeMax).getTime()

    const free = findFreeWindows(
      busy.busy,
      rangeStart,
      rangeEnd,
      durationMinutes * 60000
    )

    return JSON.stringify({
      ...busy,
      minimumDurationMinutes:
        durationMinutes,
      free
    }, null, 2)
  }

  if (name === 'calendar_update_event') {
    const event = await updateCalendarEvent(
      context.userId,
      {
        eventId: args.eventId,
        etag: args.etag,
        title: args.after.title,
        allDay: args.after.allDay,
        start: args.after.start,
        end: args.after.end,
        startDate: args.after.startDate,
        endDate: args.after.endDate,
        timeZone: args.after.timeZone,
        location: args.after.location,
        description: args.after.description
      }
    )

    return JSON.stringify({
      updated: true,
      event
    }, null, 2)
  }

  if (name === 'calendar_delete_event') {
    const result = await deleteCalendarEvent(
      context.userId,
      {
        eventId: args.eventId,
        etag: args.etag
      }
    )

    return JSON.stringify(result, null, 2)
  }

  throw new Error(
    `Unbekanntes Kalender-Tool: ${name}`
  )
}
