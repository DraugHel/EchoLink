import { Router } from 'express'

import db from '../db.js'
import { requireAuth } from '../middleware/auth.js'
import {
  listGoogleCalendars
} from '../connectors/google/calendar.js'
import {
  getCalendarEvent,
  updateCalendarEvent
} from '../connectors/google/calendarExtra.js'

const router = Router()

const DEFAULT_CODES = {
  '1': {
    title: 'Frühschicht',
    startTime: '04:00',
    endTime: '12:00'
  },
  '2': {
    title: 'Spätschicht',
    startTime: '12:00',
    endTime: '20:00'
  },
  '3': {
    title: 'Nachtschicht',
    startTime: '20:00',
    endTime: '04:00'
  }
}

function exposedError(message, statusCode = 400) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function validTime(value) {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/
    .test(String(value || ''))
}

function cleanText(value, maxLength) {
  return String(value || '')
    .trim()
    .slice(0, maxLength)
}

function cleanCalendarId(value) {
  const result = cleanText(value || 'primary', 1024)

  if (!result || /[\u0000-\u001f\u007f]/.test(result)) {
    throw exposedError('Ungültige Kalender-ID')
  }

  return result
}

function cleanReminder(value) {
  if (
    value == null ||
    value === '' ||
    value === 'default'
  ) {
    return null
  }

  const number = Number.parseInt(value, 10)

  if (!Number.isInteger(number)) {
    throw exposedError('Ungültige Erinnerung')
  }

  if (number < -1 || number > 10080) {
    throw exposedError(
      'Erinnerung muss zwischen -1 und 10080 Minuten liegen'
    )
  }

  return number
}

function cleanCodes(value) {
  const input = value && typeof value === 'object'
    ? value
    : {}

  const result = {}

  for (const code of ['1', '2', '3']) {
    const row = input[code] || DEFAULT_CODES[code]
    const title = cleanText(row.title, 120)
    const startTime = String(row.startTime || '')
    const endTime = String(row.endTime || '')

    if (!title) {
      throw exposedError(`Titel für Code ${code} fehlt`)
    }

    if (!validTime(startTime) || !validTime(endTime)) {
      throw exposedError(
        `Uhrzeit für Code ${code} ist ungültig`
      )
    }

    result[code] = {
      title,
      startTime,
      endTime
    }
  }

  return result
}

function parseCodes(value) {
  try {
    return cleanCodes(JSON.parse(value || '{}'))
  } catch {
    return structuredClone(DEFAULT_CODES)
  }
}

export function getShiftSettings(userId) {
  const row = db.prepare(`
    SELECT *
    FROM shift_settings
    WHERE user_id = ?
  `).get(userId)

  if (!row) {
    return {
      calendarId: 'primary',
      calendarName: 'Primärkalender',
      reminderMinutes: null,
      location: '',
      description: '',
      codes: structuredClone(DEFAULT_CODES)
    }
  }

  return {
    calendarId: row.calendar_id || 'primary',
    calendarName:
      row.calendar_name || 'Primärkalender',
    reminderMinutes: row.reminder_minutes,
    location: row.location || '',
    description: row.description || '',
    codes: parseCodes(row.codes_json)
  }
}


async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0

  async function next() {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1

      try {
        results[index] = await worker(
          items[index],
          index
        )
      } catch (error) {
        results[index] = {
          status: 'error',
          error:
            error?.message ||
            String(error)
        }
      }
    }
  }

  await Promise.all(
    Array.from(
      {
        length: Math.min(
          Math.max(1, limit),
          Math.max(1, items.length)
        )
      },
      () => next()
    )
  )

  return results
}

function calendarEventUpdatePayload(
  event,
  calendarId
) {
  return {
    eventId: event.id,
    calendarId,
    etag: event.etag || '',
    title: event.title,
    allDay: Boolean(event.allDay),
    start: event.start,
    end: event.end,
    startDate: event.startDate || '',
    endDate: event.endDate || '',
    timeZone:
      event.timeZone ||
      'Europe/Vienna',
    location: event.location || '',
    description:
      event.description || '',
    reminderMinutes: -1
  }
}

router.use(requireAuth)

router.get('/', (req, res) => {
  res.json(
    getShiftSettings(req.session.userId)
  )
})

router.get('/calendars', async (req, res, next) => {
  try {
    const calendars = await listGoogleCalendars(
      req.session.userId
    )

    res.json({ calendars })
  } catch (error) {
    next(error)
  }
})


router.post(
  '/remove-reminders',
  async (req, res) => {
    try {
      const rows = db.prepare(`
        SELECT
          event_id,
          COALESCE(
            NULLIF(calendar_id, ''),
            'primary'
          ) AS calendar_id,
          title,
          start_at
        FROM shift_calendar_events
        WHERE user_id = ?
          AND status = 'created'
          AND trim(event_id) <> ''
        ORDER BY start_at, id
      `).all(req.session.userId)

      const results = await mapLimit(
        rows,
        4,
        async row => {
          try {
            const event =
              await getCalendarEvent(
                req.session.userId,
                row.event_id,
                row.calendar_id
              )

            if (
              Number(
                event.reminderMinutes
              ) === -1
            ) {
              return {
                eventId: row.event_id,
                title:
                  event.title ||
                  row.title ||
                  '',
                start:
                  event.start ||
                  row.start_at ||
                  '',
                status:
                  'already_removed'
              }
            }

            const updated =
              await updateCalendarEvent(
                req.session.userId,
                calendarEventUpdatePayload(
                  event,
                  row.calendar_id
                )
              )

            db.prepare(`
              UPDATE shift_calendar_events
              SET
                title = ?,
                start_at = ?,
                end_at = ?,
                updated_at = unixepoch()
              WHERE user_id = ?
                AND event_id = ?
                AND calendar_id = ?
            `).run(
              updated.title ||
                event.title ||
                row.title ||
                '',
              updated.start ||
                event.start ||
                row.start_at ||
                '',
              updated.end ||
                event.end ||
                '',
              req.session.userId,
              row.event_id,
              row.calendar_id
            )

            return {
              eventId: row.event_id,
              title:
                updated.title ||
                event.title ||
                row.title ||
                '',
              start:
                updated.start ||
                event.start ||
                row.start_at ||
                '',
              status: 'updated'
            }
          } catch (error) {
            if (
              error?.statusCode === 404 ||
              error?.statusCode === 410
            ) {
              db.prepare(`
                UPDATE shift_calendar_events
                SET
                  status = 'missing',
                  updated_at = unixepoch()
                WHERE user_id = ?
                  AND event_id = ?
                  AND calendar_id = ?
              `).run(
                req.session.userId,
                row.event_id,
                row.calendar_id
              )

              return {
                eventId: row.event_id,
                title: row.title || '',
                start: row.start_at || '',
                status: 'missing'
              }
            }

            return {
              eventId: row.event_id,
              title: row.title || '',
              start: row.start_at || '',
              status: 'error',
              error:
                error?.message ||
                String(error)
            }
          }
        }
      )

      const summary = {
        total: rows.length,
        updated:
          results.filter(
            item =>
              item.status === 'updated'
          ).length,
        alreadyRemoved:
          results.filter(
            item =>
              item.status ===
              'already_removed'
          ).length,
        missing:
          results.filter(
            item =>
              item.status === 'missing'
          ).length,
        errors:
          results.filter(
            item =>
              item.status === 'error'
          ).length
      }

      res.json({
        summary,
        errors: results
          .filter(
            item =>
              item.status === 'error'
          )
          .slice(0, 20)
      })
    } catch (error) {
      console.error(
        'Removing shift reminders failed:',
        error?.message || error
      )

      res.status(
        error?.statusCode || 500
      ).json({
        error:
          error?.message ||
          'Erinnerungen konnten nicht entfernt werden'
      })
    }
  }
)

router.put('/', (req, res) => {
  try {
    const calendarId = cleanCalendarId(
      req.body?.calendarId
    )

    const calendarName = cleanText(
      req.body?.calendarName || 'Kalender',
      300
    )

    const reminderMinutes = cleanReminder(
      req.body?.reminderMinutes
    )

    const location = cleanText(
      req.body?.location,
      1000
    )

    const description = cleanText(
      req.body?.description,
      4000
    )

    const codes = cleanCodes(req.body?.codes)

    db.prepare(`
      INSERT INTO shift_settings (
        user_id,
        calendar_id,
        calendar_name,
        reminder_minutes,
        location,
        description,
        codes_json,
        created_at,
        updated_at
      )
      VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        unixepoch(), unixepoch()
      )
      ON CONFLICT(user_id)
      DO UPDATE SET
        calendar_id = excluded.calendar_id,
        calendar_name = excluded.calendar_name,
        reminder_minutes = excluded.reminder_minutes,
        location = excluded.location,
        description = excluded.description,
        codes_json = excluded.codes_json,
        updated_at = unixepoch()
    `).run(
      req.session.userId,
      calendarId,
      calendarName,
      reminderMinutes,
      location,
      description,
      JSON.stringify(codes)
    )

    res.json(
      getShiftSettings(req.session.userId)
    )
  } catch (error) {
    res.status(error?.statusCode || 500).json({
      error:
        error?.message ||
        'Schichtprofil konnte nicht gespeichert werden'
    })
  }
})

export default router
