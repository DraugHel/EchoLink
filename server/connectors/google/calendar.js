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
  url
) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const accessToken =
      await getGoogleAccessToken(userId, {
        forceRefresh: attempt === 1
      })

    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/json'
      },
      signal: AbortSignal.timeout(20_000)
    })

    let body = {}

    try {
      body = await response.json()
    } catch {}

    if (response.status === 401 && attempt === 0) {
      continue
    }

    if (!response.ok) {
      const message =
        body?.error?.message ||
        `HTTP ${response.status}`

      throw exposedError(
        `Google Calendar API: ${message}`,
        response.status === 403 ? 403 : 502
      )
    }

    return body
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
