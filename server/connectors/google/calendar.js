import {
  getGoogleAccessToken
} from './oauth.js'

function exposedError(message, statusCode = 500) {
  const error = new Error(message)
  error.statusCode = statusCode
  error.expose = true
  return error
}

function parseDate(value, fallback) {
  const date =
    value == null || value === ''
      ? fallback
      : new Date(value)

  if (
    !(date instanceof Date) ||
    Number.isNaN(date.getTime())
  ) {
    throw exposedError(
      `Ungültiger Kalenderzeitpunkt: ${value}`,
      400
    )
  }

  return date
}

async function googleCalendarRequest(
  userId,
  url,
  {
    method = 'GET',
    requestBody = null
  } = {}
) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const accessToken =
      await getGoogleAccessToken(userId, {
        forceRefresh: attempt === 1
      })

    const response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/json',
        ...(requestBody
          ? { 'content-type': 'application/json' }
          : {})
      },
      ...(requestBody
        ? {
            body: JSON.stringify(requestBody)
          }
        : {}),
      signal: AbortSignal.timeout(20_000)
    })

    let responseBody = {}

    try {
      responseBody = await response.json()
    } catch {}

    if (
      response.status === 401 &&
      attempt === 0
    ) {
      continue
    }

    if (!response.ok) {
      const message =
        responseBody?.error?.message ||
        `HTTP ${response.status}`

      throw exposedError(
        `Google Calendar API: ${message}`,
        response.status === 403 ? 403 : 502
      )
    }

    return responseBody
  }

  throw exposedError(
    'Google Calendar konnte nicht autorisiert werden',
    502
  )
}

export async function listCalendarEvents(
  userId,
  {
    timeMin,
    timeMax,
    maxResults = 20,
    timeZone = 'Europe/Vienna'
  } = {}
) {
  const start = parseDate(
    timeMin,
    new Date()
  )

  const end = parseDate(
    timeMax,
    new Date(start.getTime() + 7 * 86400_000)
  )

  if (end <= start) {
    throw exposedError(
      'timeMax muss nach timeMin liegen',
      400
    )
  }

  const limit = Math.min(
    50,
    Math.max(1, Number(maxResults) || 20)
  )

  const params = new URLSearchParams({
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    maxResults: String(limit),
    singleEvents: 'true',
    orderBy: 'startTime',
    showDeleted: 'false',
    timeZone
  })

  const url =
    'https://www.googleapis.com/calendar/v3/' +
    `calendars/primary/events?${params}`

  const result = await googleCalendarRequest(
    userId,
    url
  )

  return {
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    timeZone,
    events: (result.items || []).map(event => ({
      id: event.id,
      title: event.summary || '(Ohne Titel)',
      status: event.status,
      start:
        event.start?.dateTime ||
        event.start?.date ||
        null,
      end:
        event.end?.dateTime ||
        event.end?.date ||
        null,
      allDay: Boolean(event.start?.date),
      location: event.location || '',
      description:
        String(event.description || '').slice(0, 2000),
      attendeeCount:
        Array.isArray(event.attendees)
          ? event.attendees.length
          : 0,
      link: event.htmlLink || ''
    }))
  }
}


function requiredEventText(
  value,
  name,
  maxLength
) {
  if (typeof value !== 'string') {
    throw exposedError(`${name} muss Text sein`, 400)
  }

  const result = value.trim()

  if (!result) {
    throw exposedError(`${name} darf nicht leer sein`, 400)
  }

  if (result.length > maxLength) {
    throw exposedError(
      `${name} ist zu lang`,
      400
    )
  }

  return result
}

function optionalEventText(
  value,
  maxLength
) {
  if (value == null || value === '') return ''

  if (typeof value !== 'string') {
    throw exposedError(
      'Ungültiger Textwert für Kalendertermin',
      400
    )
  }

  return value.trim().slice(0, maxLength)
}

function validateTimeZone(value) {
  const timeZone =
    String(value || 'Europe/Vienna').trim()

  try {
    new Intl.DateTimeFormat('de-AT', {
      timeZone
    }).format(new Date())
  } catch {
    throw exposedError(
      `Ungültige Zeitzone: ${timeZone}`,
      400
    )
  }

  return timeZone
}

function parseDateOnly(value, name) {
  const text = String(value || '').trim()

  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw exposedError(
      `${name} muss YYYY-MM-DD entsprechen`,
      400
    )
  }

  const [year, month, day] =
    text.split('-').map(Number)

  const date = new Date(
    Date.UTC(year, month - 1, day)
  )

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw exposedError(
      `${name} ist kein gültiges Datum`,
      400
    )
  }

  return text
}

function addDateOnlyDays(value, days) {
  const [year, month, day] =
    value.split('-').map(Number)

  const date = new Date(
    Date.UTC(year, month - 1, day + days)
  )

  return date.toISOString().slice(0, 10)
}

export async function createCalendarEvent(
  userId,
  {
    title,
    start,
    end,
    allDay = false,
    startDate = '',
    endDate = '',
    timeZone = 'Europe/Vienna',
    location = '',
    description = ''
  }
) {
  const summary = requiredEventText(
    title,
    'Titel',
    300
  )

  let payload

  if (allDay) {
    const firstDay = parseDateOnly(
      startDate || start,
      'Startdatum'
    )

    const lastDay = parseDateOnly(
      endDate || startDate || start,
      'Enddatum'
    )

    if (lastDay < firstDay) {
      throw exposedError(
        'Das Enddatum darf nicht vor dem Startdatum liegen',
        400
      )
    }

    payload = {
      summary,
      start: {
        date: firstDay
      },
      end: {
        // Google verwendet bei Ganztagsterminen
        // ein exklusives Enddatum.
        date: addDateOnlyDays(lastDay, 1)
      }
    }
  } else {
    const startDateTime = parseDate(start)
    const endDateTime = parseDate(end)

    if (endDateTime <= startDateTime) {
      throw exposedError(
        'Das Terminende muss nach dem Beginn liegen',
        400
      )
    }

    const zone = validateTimeZone(timeZone)

    payload = {
      summary,
      start: {
        dateTime: startDateTime.toISOString(),
        timeZone: zone
      },
      end: {
        dateTime: endDateTime.toISOString(),
        timeZone: zone
      }
    }
  }

  const cleanLocation =
    optionalEventText(location, 1000)

  const cleanDescription =
    optionalEventText(description, 8000)

  if (cleanLocation) {
    payload.location = cleanLocation
  }

  if (cleanDescription) {
    payload.description = cleanDescription
  }

  const url =
    'https://www.googleapis.com/calendar/v3/' +
    'calendars/primary/events?sendUpdates=none'

  const event = await googleCalendarRequest(
    userId,
    url,
    {
      method: 'POST',
      requestBody: payload
    }
  )

  const createdAllDay =
    Boolean(event.start?.date)

  return {
    id: event.id,
    title: event.summary || summary,
    allDay: createdAllDay,
    start:
      event.start?.dateTime ||
      event.start?.date ||
      null,
    end:
      event.end?.dateTime ||
      event.end?.date ||
      null,
    startDate:
      createdAllDay
        ? event.start?.date || null
        : null,
    endDate:
      createdAllDay && event.end?.date
        ? addDateOnlyDays(event.end.date, -1)
        : null,
    location: event.location || '',
    description: event.description || '',
    status: event.status || '',
    link: event.htmlLink || ''
  }
}
