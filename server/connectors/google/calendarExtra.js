import {
  getGoogleAccessToken
} from './oauth.js'

const API_ROOT =
  'https://www.googleapis.com/calendar/v3'

function exposedError(message, statusCode = 500) {
  const error = new Error(message)
  error.statusCode = statusCode
  error.expose = true
  return error
}

function requireEventId(value) {
  const eventId = String(value || '').trim()

  if (!eventId || eventId.length > 1024) {
    throw exposedError(
      'Ungültige Kalendertermin-ID',
      400
    )
  }

  return eventId
}

function parseDate(value, name) {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    throw exposedError(
      `${name} ist kein gültiger Zeitpunkt`,
      400
    )
  }

  return date
}

function parseDateOnly(value, name) {
  const result = String(value || '').trim()

  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) {
    throw exposedError(
      `${name} muss YYYY-MM-DD entsprechen`,
      400
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
    throw exposedError(
      `${name} ist kein gültiges Datum`,
      400
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

async function calendarRequest(
  userId,
  url,
  {
    method = 'GET',
    requestBody = null,
    extraHeaders = {}
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
        ...extraHeaders,
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

    const responseText = await response.text()
    let responseBody = {}

    if (responseText) {
      try {
        responseBody = JSON.parse(responseText)
      } catch {}
    }

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

      const statusCode =
        response.status === 403
          ? 403
          : response.status === 404
            ? 404
            : response.status === 412
              ? 409
              : 502

      throw exposedError(
        `Google Calendar API: ${message}`,
        statusCode
      )
    }

    return responseBody
  }

  throw exposedError(
    'Google Calendar konnte nicht autorisiert werden',
    502
  )
}

function eventToJson(event) {
  const allDay = Boolean(event.start?.date)

  const startDate = allDay
    ? event.start?.date || null
    : null

  // Google liefert hier den Folgetag als
  // exklusives Enddatum.
  const endDate =
    allDay && event.end?.date
      ? addDateOnlyDays(event.end.date, -1)
      : null

  return {
    id: event.id,
    etag: event.etag || '',
    title: event.summary || '(Ohne Titel)',
    status: event.status || '',
    allDay,
    start: allDay
      ? startDate
      : event.start?.dateTime || null,
    end: allDay
      ? endDate
      : event.end?.dateTime || null,
    startDate,
    endDate,
    timeZone:
      event.start?.timeZone ||
      event.end?.timeZone ||
      'Europe/Vienna',
    location: event.location || '',
    description: event.description || '',
    recurringEventId:
      event.recurringEventId || null,
    link: event.htmlLink || ''
  }
}

export async function getCalendarEvent(
  userId,
  eventId
) {
  const id = requireEventId(eventId)

  const event = await calendarRequest(
    userId,
    `${API_ROOT}/calendars/primary/events/` +
      encodeURIComponent(id)
  )

  return eventToJson(event)
}

export async function updateCalendarEvent(
  userId,
  {
    eventId,
    etag = '',
    title,
    allDay = false,
    start,
    end,
    startDate = '',
    endDate = '',
    timeZone = 'Europe/Vienna',
    location = '',
    description = ''
  }
) {
  const id = requireEventId(eventId)
  const cleanTitle = String(title || '').trim()

  if (!cleanTitle) {
    throw exposedError(
      'Der Termintitel darf nicht leer sein',
      400
    )
  }

  let timePayload

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

    timePayload = {
      start: {
        date: firstDay
      },
      end: {
        date: addDateOnlyDays(lastDay, 1)
      }
    }
  } else {
    const startDateTime =
      parseDate(start, 'Beginn')

    const endDateTime =
      parseDate(end, 'Ende')

    if (endDateTime <= startDateTime) {
      throw exposedError(
        'Das Terminende muss nach dem Beginn liegen',
        400
      )
    }

    const zone = validateTimeZone(timeZone)

    timePayload = {
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

  const event = await calendarRequest(
    userId,
    `${API_ROOT}/calendars/primary/events/` +
      `${encodeURIComponent(id)}?sendUpdates=none`,
    {
      method: 'PATCH',
      requestBody: {
        summary: cleanTitle,
        location: String(location || '').trim(),
        description:
          String(description || '').trim(),
        ...timePayload
      },
      extraHeaders: etag
        ? { 'If-Match': etag }
        : {}
    }
  )

  return eventToJson(event)
}

export async function deleteCalendarEvent(
  userId,
  {
    eventId,
    etag = ''
  }
) {
  const id = requireEventId(eventId)

  await calendarRequest(
    userId,
    `${API_ROOT}/calendars/primary/events/` +
      `${encodeURIComponent(id)}?sendUpdates=none`,
    {
      method: 'DELETE',
      extraHeaders: etag
        ? { 'If-Match': etag }
        : {}
    }
  )

  return {
    deleted: true,
    eventId: id
  }
}

export async function getCalendarBusy(
  userId,
  {
    timeMin,
    timeMax,
    timeZone = 'Europe/Vienna'
  }
) {
  const start = parseDate(timeMin, 'timeMin')
  const end = parseDate(timeMax, 'timeMax')

  if (end <= start) {
    throw exposedError(
      'timeMax muss nach timeMin liegen',
      400
    )
  }

  const zone = validateTimeZone(timeZone)

  const result = await calendarRequest(
    userId,
    `${API_ROOT}/freeBusy`,
    {
      method: 'POST',
      requestBody: {
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        timeZone: zone,
        items: [
          { id: 'primary' }
        ]
      }
    }
  )

  const calendar =
    result.calendars?.primary || {}

  if (calendar.errors?.length) {
    throw exposedError(
      'Free/Busy-Abfrage ist fehlgeschlagen',
      502
    )
  }

  return {
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    timeZone: zone,
    busy: (calendar.busy || []).map(item => ({
      start: item.start,
      end: item.end
    }))
  }
}
