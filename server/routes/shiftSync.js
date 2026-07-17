import { Router } from 'express'

import db from '../db.js'
import { requireAuth } from '../middleware/auth.js'
import {
  createCalendarEvent,
  listCalendarEvents
} from '../connectors/google/calendar.js'
import {
  deleteCalendarEvent,
  getCalendarEvent,
  updateCalendarEvent
} from '../connectors/google/calendarExtra.js'
import {
  getShiftSettings
} from './shiftSettings.js'

const router = Router()

const ACTIONABLE_TYPES = new Set([
  'create',
  'update',
  'delete'
])

const SHIFT_TITLES = new Set([
  'frühschicht',
  'spätschicht',
  'nachtschicht'
])

function exposedError(message, statusCode = 400) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function integer(value, name) {
  const parsed = Number.parseInt(value, 10)

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw exposedError(`${name} ist ungültig`)
  }

  return parsed
}

function validDate(value) {
  const text = String(value || '').trim()

  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return false
  }

  const [year, month, day] =
    text.split('-').map(Number)

  const date = new Date(
    Date.UTC(year, month - 1, day)
  )

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  )
}

function validTime(value) {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/
    .test(String(value || ''))
}

function addDays(dateText, days) {
  const [year, month, day] =
    dateText.split('-').map(Number)

  return new Date(
    Date.UTC(year, month - 1, day + days)
  ).toISOString().slice(0, 10)
}

function normalizeTitle(value) {
  return String(value || '')
    .trim()
    .toLocaleLowerCase('de-AT')
    .replace(/\s+/g, ' ')
}

function zonedLocalToIso(
  dateText,
  timeText,
  timeZone
) {
  const [year, month, day] =
    dateText.split('-').map(Number)

  const [hour, minute] =
    timeText.split(':').map(Number)

  const desiredUtc = Date.UTC(
    year,
    month - 1,
    day,
    hour,
    minute,
    0
  )

  const formatter = new Intl.DateTimeFormat(
    'en-CA',
    {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    }
  )

  let guess = desiredUtc

  for (let pass = 0; pass < 2; pass += 1) {
    const parts = Object.fromEntries(
      formatter
        .formatToParts(new Date(guess))
        .filter(part => part.type !== 'literal')
        .map(part => [part.type, part.value])
    )

    const representedUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second)
    )

    guess += desiredUtc - representedUtc
  }

  return new Date(guess).toISOString()
}

function localDateFromIso(value, timeZone) {
  const date = new Date(value)

  if (!Number.isFinite(date.getTime())) {
    return ''
  }

  const parts = Object.fromEntries(
    new Intl.DateTimeFormat(
      'en-CA',
      {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }
    )
      .formatToParts(date)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value])
  )

  return [
    parts.year,
    parts.month,
    parts.day
  ].join('-')
}

function sameInstant(left, right) {
  const leftTime = new Date(left).getTime()
  const rightTime = new Date(right).getTime()

  return (
    Number.isFinite(leftTime) &&
    Number.isFinite(rightTime) &&
    leftTime === rightTime
  )
}

function eventTimeTitleEquals(left, right) {
  return (
    normalizeTitle(left?.title) ===
      normalizeTitle(right?.title) &&
    Boolean(left?.allDay) ===
      Boolean(right?.allDay) &&
    sameInstant(left?.start, right?.start) &&
    sameInstant(left?.end, right?.end)
  )
}

function normalizedDescription(value) {
  return String(value || '')
    .split(/\r?\n/)
    .filter(line =>
      !/^EchoLink-Schichtimport:/i.test(
        line.trim()
      )
    )
    .join('\n')
    .trim()
}

function eventManagedEquals(left, right) {
  return (
    eventTimeTitleEquals(left, right) &&
    String(left?.location || '').trim() ===
      String(right?.location || '').trim() &&
    normalizedDescription(left?.description) ===
      normalizedDescription(right?.description) &&
    Number(left?.reminderMinutes ?? -999) ===
      Number(right?.reminderMinutes ?? -999)
  )
}

function parseJson(value, fallback = null) {
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function workDateFromDescription(description) {
  const match = String(description || '')
    .match(
      /(?:Plan-Datum|EchoLink-Schichtdatum):\s*(\d{4}-\d{2}-\d{2})/i
    )

  return validDate(match?.[1])
    ? match[1]
    : ''
}

function isManagedDescription(description) {
  return /EchoLink-Schichtimport:[a-f0-9]{64}/i
    .test(String(description || ''))
}

function isShiftLike(event) {
  return (
    SHIFT_TITLES.has(
      normalizeTitle(event?.title)
    ) ||
    isManagedDescription(event?.description)
  )
}

function desiredFromItem(item, timeZone, settings) {
  const endDate =
    item.end_time <= item.start_time
      ? addDays(item.work_date, 1)
      : item.work_date

  return {
    title: item.title,
    allDay: false,
    start: zonedLocalToIso(
      item.work_date,
      item.start_time,
      timeZone
    ),
    end: zonedLocalToIso(
      endDate,
      item.end_time,
      timeZone
    ),
    timeZone,
    location: settings.location || '',
    reminderMinutes: settings.reminderMinutes,
    description: [
      settings.description || '',
      `Schichtcode: ${item.code}`,
      `Plan-Datum: ${item.work_date}`,
      `EchoLink-Schichtdatum:${item.work_date}`
    ].filter(Boolean).join('\n'),
    workDate: item.work_date,
    code: item.code
  }
}

function calendarPayload(
  snapshot,
  timeZone,
  calendarId,
  reminderMinutes
) {
  return {
    calendarId,
    title: snapshot.title,
    allDay: false,
    start: snapshot.start,
    end: snapshot.end,
    timeZone:
      snapshot.timeZone ||
      timeZone,
    location:
      snapshot.location || '',
    description:
      snapshot.description || '',
    reminderMinutes:
      snapshot.reminderMinutes ??
      reminderMinutes
  }
}

function ownedImport(importId, userId) {
  return db.prepare(`
    SELECT *
    FROM shift_imports
    WHERE id = ? AND user_id = ?
  `).get(importId, userId)
}

function ownedRun(runId, userId) {
  return db.prepare(`
    SELECT *
    FROM shift_sync_runs
    WHERE id = ? AND user_id = ?
  `).get(runId, userId)
}

function serializeRun(row) {
  return {
    id: row.id,
    importId: row.import_id,
    status: row.status,
    timeZone: row.time_zone,
    calendarId: row.calendar_id || 'primary',
    reminderMinutes: row.reminder_minutes,
    summary:
      parseJson(row.summary_json, {}),
    createdAt: row.created_at,
    appliedAt: row.applied_at,
    rolledBackAt: row.rolled_back_at
  }
}

function serializeAction(row) {
  return {
    id: row.id,
    runId: row.run_id,
    importItemId: row.import_item_id,
    workDate: row.work_date,
    actionType: row.action_type,
    selected: Boolean(row.selected),
    status: row.status,
    eventId: row.event_id,
    oldEvent:
      parseJson(row.old_event_json, null),
    newEvent:
      parseJson(row.new_event_json, null),
    message: row.message || '',
    error: row.error || ''
  }
}

function withActions(run) {
  const actions = db.prepare(`
    SELECT *
    FROM shift_sync_actions
    WHERE run_id = ?
    ORDER BY work_date, id
  `).all(run.id)

  return {
    run: serializeRun(run),
    actions: actions.map(serializeAction)
  }
}

async function listEventsInRange(
  userId,
  startDate,
  endDate,
  timeZone,
  calendarId
) {
  const byId = new Map()
  const warnings = []

  let cursor = startDate
  const endExclusive = addDays(endDate, 2)

  while (cursor < endExclusive) {
    const weekEnd = addDays(cursor, 7)
    const next =
      weekEnd < endExclusive
        ? weekEnd
        : endExclusive

    const result = await listCalendarEvents(
      userId,
      {
        timeMin: zonedLocalToIso(
          cursor,
          '00:00',
          timeZone
        ),
        timeMax: zonedLocalToIso(
          next,
          '00:00',
          timeZone
        ),
        maxResults: 50,
        timeZone,
        calendarId
      }
    )

    if (result.events.length >= 50) {
      warnings.push(
        `Im Kalenderfenster ${cursor} bis ${next} wurden mindestens 50 Termine gefunden; der Vergleich könnte unvollständig sein.`
      )
    }

    for (const event of result.events) {
      if (event?.id) {
        byId.set(event.id, event)
      }
    }

    cursor = next
  }

  return {
    events: [...byId.values()],
    warnings
  }
}

function managedEventIds(userId, calendarId) {
  const rows = db.prepare(`
    SELECT event_id
    FROM shift_calendar_events
    WHERE user_id = ?
      AND calendar_id = ?
      AND status = 'created'
      AND trim(event_id) <> ''
  `).all(userId, calendarId)

  return new Set(
    rows.map(row => row.event_id)
  )
}

function insertAction(
  runId,
  {
    importItemId = null,
    workDate,
    actionType,
    selected = false,
    eventId = '',
    oldEvent = null,
    newEvent = null,
    message = ''
  }
) {
  db.prepare(`
    INSERT INTO shift_sync_actions (
      run_id,
      import_item_id,
      work_date,
      action_type,
      selected,
      status,
      event_id,
      old_event_json,
      new_event_json,
      message,
      error,
      created_at,
      updated_at
    )
    VALUES (
      ?,
      ?,
      ?,
      ?,
      ?,
      'pending',
      ?,
      ?,
      ?,
      ?,
      '',
      unixepoch(),
      unixepoch()
    )
  `).run(
    runId,
    importItemId,
    workDate,
    actionType,
    selected ? 1 : 0,
    eventId,
    JSON.stringify(oldEvent),
    JSON.stringify(newEvent),
    message
  )
}

function upsertManagedEvent(
  userId,
  fingerprint,
  event,
  calendarId
) {
  db.prepare(`
    DELETE FROM shift_calendar_events
    WHERE user_id = ?
      AND calendar_id = ?
      AND event_id = ?
  `).run(
    userId,
    calendarId,
    event.id
  )

  db.prepare(`
    INSERT INTO shift_calendar_events (
      user_id,
      calendar_id,
      fingerprint,
      event_id,
      title,
      start_at,
      end_at,
      status,
      created_at,
      updated_at
    )
    VALUES (
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      'created',
      unixepoch(),
      unixepoch()
    )
    ON CONFLICT(user_id, fingerprint)
    DO UPDATE SET
      event_id = excluded.event_id,
      title = excluded.title,
      start_at = excluded.start_at,
      end_at = excluded.end_at,
      status = 'created',
      updated_at = unixepoch()
  `).run(
    userId,
    calendarId,
    fingerprint,
    event.id || '',
    event.title || '',
    event.start || '',
    event.end || ''
  )
}
function markManagedDeleted(
  userId,
  eventId,
  calendarId
) {
  db.prepare(`
    UPDATE shift_calendar_events
    SET
      status = 'deleted',
      updated_at = unixepoch()
    WHERE user_id = ?
      AND calendar_id = ?
      AND event_id = ?
  `).run(userId, calendarId, eventId)
}

function updateImportItem(
  action,
  status,
  eventId = '',
  error = ''
) {
  if (!action.import_item_id) return

  let importStatus = 'pending'

  if (
    status === 'created' ||
    status === 'updated'
  ) {
    importStatus = 'created'
  } else if (
    status === 'unchanged' ||
    status === 'manual_existing'
  ) {
    importStatus = 'duplicate'
  } else if (status === 'error') {
    importStatus = 'error'
  }

  db.prepare(`
    UPDATE shift_import_items
    SET
      import_status = ?,
      event_id = ?,
      error = ?,
      updated_at = unixepoch()
    WHERE id = ?
  `).run(
    importStatus,
    eventId,
    String(error || '').slice(0, 1000),
    action.import_item_id
  )
}

router.get(
  '/imports/:importId/latest',
  requireAuth,
  (req, res) => {
    try {
      const importId = integer(
        req.params.importId,
        'Import-ID'
      )

      if (!ownedImport(
        importId,
        req.session.userId
      )) {
        return res.status(404).json({
          error: 'Schichtimport nicht gefunden'
        })
      }

      const run = db.prepare(`
        SELECT *
        FROM shift_sync_runs
        WHERE import_id = ?
          AND user_id = ?
        ORDER BY id DESC
        LIMIT 1
      `).get(
        importId,
        req.session.userId
      )

      if (!run) {
        return res.json({
          run: null,
          actions: []
        })
      }

      res.json(withActions(run))
    } catch (error) {
      res.status(
        error?.statusCode || 500
      ).json({
        error:
          error?.message ||
          'Sync-Lauf konnte nicht geladen werden'
      })
    }
  }
)

router.post(
  '/imports/:importId/compare',
  requireAuth,
  async (req, res) => {
    try {
      const importId = integer(
        req.params.importId,
        'Import-ID'
      )

      const importRow = ownedImport(
        importId,
        req.session.userId
      )

      if (!importRow) {
        return res.status(404).json({
          error: 'Schichtimport nicht gefunden'
        })
      }

      const timeZone =
        String(
          req.body?.timeZone ||
          'Europe/Vienna'
        ).trim()

      try {
        new Intl.DateTimeFormat(
          'de-AT',
          { timeZone }
        ).format(new Date())
      } catch {
        throw exposedError(
          'Ungültige Zeitzone'
        )
      }

      const items = db.prepare(`
        SELECT *
        FROM shift_import_items
        WHERE import_id = ?
          AND enabled = 1
        ORDER BY work_date, id
      `).all(importId)

      if (items.length === 0) {
        throw exposedError(
          'Keine aktiven Schichten für den Vergleich'
        )
      }

      for (const item of items) {
        if (
          !['1', '2', '3'].includes(item.code) ||
          !validDate(item.work_date) ||
          !validTime(item.start_time) ||
          !validTime(item.end_time) ||
          !String(item.title || '').trim()
        ) {
          throw exposedError(
            `Ungültige aktive Schicht am ${item.work_date}`
          )
        }
      }

      const rangeStart =
        validDate(importRow.plan_start)
          ? importRow.plan_start
          : items[0].work_date

      const rangeEnd =
        validDate(importRow.plan_end)
          ? importRow.plan_end
          : items.at(-1).work_date

      const settings =
        getShiftSettings(
          req.session.userId
        )

      const calendar =
        await listEventsInRange(
          req.session.userId,
          rangeStart,
          rangeEnd,
          timeZone,
          settings.calendarId
        )

      const knownManaged =
        managedEventIds(
          req.session.userId,
          settings.calendarId
        )

      const events = calendar.events.map(
        event => {
          const managed =
            knownManaged.has(event.id) ||
            isManagedDescription(
              event.description
            )

          const workDate =
            workDateFromDescription(
              event.description
            ) ||
            localDateFromIso(
              event.start,
              timeZone
            )

          return {
            ...event,
            managed,
            workDate
          }
        }
      )

      const managedByDate = new Map()
      const manualByDate = new Map()

      for (const event of events) {
        if (!validDate(event.workDate)) {
          continue
        }

        const target =
          event.managed
            ? managedByDate
            : manualByDate

        if (!target.has(event.workDate)) {
          target.set(event.workDate, [])
        }

        target.get(event.workDate)
          .push(event)
      }

      const runResult = db.prepare(`
        INSERT INTO shift_sync_runs (
          user_id,
          import_id,
          time_zone,
          calendar_id,
          reminder_minutes,
          status,
          summary_json,
          created_at
        )
        VALUES (
          ?,
          ?,
          ?,
          ?,
          ?,
          'draft',
          '{}',
          unixepoch()
        )
      `).run(
        req.session.userId,
        importId,
        timeZone,
        settings.calendarId,
        settings.reminderMinutes
      )

      const runId =
        Number(runResult.lastInsertRowid)

      const usedIds = new Set()
      const summary = {
        create: 0,
        update: 0,
        delete: 0,
        unchanged: 0,
        manualExisting: 0,
        conflicts: 0,
        warnings: calendar.warnings
      }

      for (const item of items) {
        const desired = desiredFromItem(
          item,
          timeZone,
          settings
        )

        const managedCandidates =
          managedByDate.get(
            item.work_date
          ) || []

        const managed =
          managedCandidates.find(
            event =>
              !usedIds.has(event.id)
          )

        if (managed) {
          usedIds.add(managed.id)

          const exact =
            eventManagedEquals(managed, desired)

          const actionType =
            exact
              ? 'unchanged'
              : 'update'

          summary[actionType] += 1

          insertAction(
            runId,
            {
              importItemId: item.id,
              workDate: item.work_date,
              actionType,
              selected: !exact,
              eventId: managed.id,
              oldEvent: managed,
              newEvent: desired,
              message:
                exact
                  ? 'Der von EchoLink verwaltete Termin stimmt bereits.'
                  : 'Der von EchoLink verwaltete Termin wird an den neuen Plan angepasst.'
            }
          )

          continue
        }

        const manualCandidates =
          manualByDate.get(
            item.work_date
          ) || []

        const exactManual =
          manualCandidates.find(
            event =>
              !usedIds.has(event.id) &&
              eventTimeTitleEquals(event, desired)
          )

        if (exactManual) {
          usedIds.add(exactManual.id)
          summary.manualExisting += 1

          insertAction(
            runId,
            {
              importItemId: item.id,
              workDate: item.work_date,
              actionType:
                'manual_existing',
              selected: false,
              eventId: exactManual.id,
              oldEvent: exactManual,
              newEvent: desired,
              message:
                'Ein exakt passender manueller Termin ist schon vorhanden und bleibt unangetastet.'
            }
          )

          continue
        }

        const conflict =
          manualCandidates.find(
            event =>
              !usedIds.has(event.id) &&
              isShiftLike(event)
          )

        if (conflict) {
          usedIds.add(conflict.id)
          summary.conflicts += 1

          insertAction(
            runId,
            {
              importItemId: item.id,
              workDate: item.work_date,
              actionType: 'conflict',
              selected: false,
              eventId: conflict.id,
              oldEvent: conflict,
              newEvent: desired,
              message:
                'Ein abweichender manueller Schichttermin wurde gefunden. EchoLink verändert ihn nicht automatisch.'
            }
          )

          continue
        }

        summary.create += 1

        insertAction(
          runId,
          {
            importItemId: item.id,
            workDate: item.work_date,
            actionType: 'create',
            selected: true,
            oldEvent: null,
            newEvent: desired,
            message:
              'Diese Schicht wird neu erstellt.'
          }
        )
      }

      for (const event of events) {
        if (
          !event.managed ||
          usedIds.has(event.id) ||
          !validDate(event.workDate) ||
          event.workDate < rangeStart ||
          event.workDate > rangeEnd
        ) {
          continue
        }

        summary.delete += 1

        insertAction(
          runId,
          {
            workDate: event.workDate,
            actionType: 'delete',
            selected: false,
            eventId: event.id,
            oldEvent: event,
            newEvent: null,
            message:
              'Diese früher von EchoLink importierte Schicht fehlt im neuen Plan. Löschen ist standardmäßig deaktiviert.'
          }
        )
      }

      db.prepare(`
        UPDATE shift_sync_runs
        SET summary_json = ?
        WHERE id = ?
      `).run(
        JSON.stringify(summary),
        runId
      )

      res.json(
        withActions(
          ownedRun(
            runId,
            req.session.userId
          )
        )
      )
    } catch (error) {
      console.error(
        'Shift compare failed:',
        error?.message || error
      )

      res.status(
        error?.statusCode || 500
      ).json({
        error:
          error?.message ||
          'Kalendervergleich fehlgeschlagen'
      })
    }
  }
)

router.post(
  '/runs/:runId/apply',
  requireAuth,
  async (req, res) => {
    try {
      const runId = integer(
        req.params.runId,
        'Sync-ID'
      )

      const run = ownedRun(
        runId,
        req.session.userId
      )

      if (!run) {
        return res.status(404).json({
          error: 'Sync-Lauf nicht gefunden'
        })
      }

      if (run.status !== 'draft') {
        throw exposedError(
          'Dieser Lauf wurde bereits ausgeführt'
        )
      }

      const selectedIds = new Set(
        (
          Array.isArray(
            req.body?.selectedActionIds
          )
            ? req.body.selectedActionIds
            : []
        )
          .map(Number)
          .filter(Number.isInteger)
      )

      const actions = db.prepare(`
        SELECT *
        FROM shift_sync_actions
        WHERE run_id = ?
        ORDER BY id
      `).all(runId)

      const results = []

      for (const action of actions) {
        const actionable =
          ACTIONABLE_TYPES.has(
            action.action_type
          )

        const selected =
          actionable &&
          selectedIds.has(action.id)

        if (!actionable) {
          db.prepare(`
            UPDATE shift_sync_actions
            SET
              selected = 0,
              status = 'skipped',
              updated_at = unixepoch()
            WHERE id = ?
          `).run(action.id)

          updateImportItem(
            action,
            action.action_type,
            action.event_id || ''
          )

          results.push({
            actionId: action.id,
            status: action.action_type
          })

          continue
        }

        if (!selected) {
          db.prepare(`
            UPDATE shift_sync_actions
            SET
              selected = 0,
              status = 'skipped',
              updated_at = unixepoch()
            WHERE id = ?
          `).run(action.id)

          results.push({
            actionId: action.id,
            status: 'skipped'
          })

          continue
        }

        const oldPreview =
          parseJson(
            action.old_event_json,
            null
          )

        const desired =
          parseJson(
            action.new_event_json,
            null
          )

        try {
          if (action.action_type === 'create') {
            const crypto =
              await import('node:crypto')

            const fingerprint = crypto
              .createHash('sha256')
              .update([
                String(req.session.userId),
                desired.workDate,
                desired.start,
                desired.end
              ].join('|'))
              .digest('hex')

            desired.description = [
              desired.description || '',
              `EchoLink-Schichtimport:${fingerprint}`
            ].filter(Boolean).join('\n')

            const created =
              await createCalendarEvent(
                req.session.userId,
                calendarPayload(
                  desired,
                  run.time_zone,
                  run.calendar_id,
                  run.reminder_minutes
                )
              )

            upsertManagedEvent(
              req.session.userId,
              fingerprint,
              created,
              run.calendar_id
            )

            db.prepare(`
              UPDATE shift_sync_actions
              SET
                selected = 1,
                status = 'applied',
                event_id = ?,
                new_event_json = ?,
                updated_at = unixepoch()
              WHERE id = ?
            `).run(
              created.id || '',
              JSON.stringify({
                ...desired,
                ...created
              }),
              action.id
            )

            updateImportItem(
              action,
              'created',
              created.id || ''
            )

            results.push({
              actionId: action.id,
              status: 'created',
              eventId: created.id || ''
            })

            continue
          }

          const current =
            await getCalendarEvent(
              req.session.userId,
              action.event_id,
              run.calendar_id
            )

          if (
            oldPreview &&
            !eventManagedEquals(current, oldPreview)
          ) {
            throw exposedError(
              'Der Termin wurde seit dem Vergleich verändert. Bitte neu vergleichen.',
              409
            )
          }

          db.prepare(`
            UPDATE shift_sync_actions
            SET old_event_json = ?
            WHERE id = ?
          `).run(
            JSON.stringify(current),
            action.id
          )

          if (action.action_type === 'update') {
            const crypto =
              await import('node:crypto')

            const fingerprint = crypto
              .createHash('sha256')
              .update([
                String(req.session.userId),
                desired.workDate,
                desired.start,
                desired.end
              ].join('|'))
              .digest('hex')

            desired.description = [
              desired.description || '',
              `EchoLink-Schichtimport:${fingerprint}`
            ].filter(Boolean).join('\n')

            const updated =
              await updateCalendarEvent(
                req.session.userId,
                {
                  eventId: action.event_id,
                  calendarId: run.calendar_id,
                  etag: current.etag || '',
                  ...calendarPayload(
                    desired,
                    run.time_zone,
                    run.calendar_id,
                    run.reminder_minutes
                  )
                }
              )

            upsertManagedEvent(
              req.session.userId,
              fingerprint,
              updated,
              run.calendar_id
            )

            db.prepare(`
              UPDATE shift_sync_actions
              SET
                selected = 1,
                status = 'applied',
                new_event_json = ?,
                updated_at = unixepoch()
              WHERE id = ?
            `).run(
              JSON.stringify({
                ...desired,
                ...updated
              }),
              action.id
            )

            updateImportItem(
              action,
              'updated',
              updated.id ||
                action.event_id
            )

            results.push({
              actionId: action.id,
              status: 'updated',
              eventId:
                updated.id ||
                action.event_id
            })

            continue
          }

          await deleteCalendarEvent(
            req.session.userId,
            {
              eventId: action.event_id,
              calendarId: run.calendar_id,
              etag: current.etag || ''
            }
          )

          markManagedDeleted(
            req.session.userId,
            action.event_id,
            run.calendar_id
          )

          db.prepare(`
            UPDATE shift_sync_actions
            SET
              selected = 1,
              status = 'applied',
              updated_at = unixepoch()
            WHERE id = ?
          `).run(action.id)

          results.push({
            actionId: action.id,
            status: 'deleted',
            eventId: action.event_id
          })
        } catch (error) {
          const message =
            error?.message || String(error)

          db.prepare(`
            UPDATE shift_sync_actions
            SET
              selected = 1,
              status = 'error',
              error = ?,
              updated_at = unixepoch()
            WHERE id = ?
          `).run(
            message.slice(0, 1000),
            action.id
          )

          updateImportItem(
            action,
            'error',
            action.event_id || '',
            message
          )

          results.push({
            actionId: action.id,
            status: 'error',
            error: message
          })
        }
      }

      const summary = {
        created:
          results.filter(
            item =>
              item.status === 'created'
          ).length,
        updated:
          results.filter(
            item =>
              item.status === 'updated'
          ).length,
        deleted:
          results.filter(
            item =>
              item.status === 'deleted'
          ).length,
        unchanged:
          results.filter(
            item =>
              item.status === 'unchanged'
          ).length,
        manualExisting:
          results.filter(
            item =>
              item.status ===
              'manual_existing'
          ).length,
        conflicts:
          results.filter(
            item =>
              item.status === 'conflict'
          ).length,
        skipped:
          results.filter(
            item =>
              item.status === 'skipped'
          ).length,
        errors:
          results.filter(
            item =>
              item.status === 'error'
          ).length
      }

      const status =
        summary.errors > 0
          ? 'partial'
          : 'applied'

      db.prepare(`
        UPDATE shift_sync_runs
        SET
          status = ?,
          summary_json = ?,
          applied_at = unixepoch()
        WHERE id = ?
      `).run(
        status,
        JSON.stringify(summary),
        runId
      )

      db.prepare(`
        UPDATE shift_imports
        SET
          status = ?,
          updated_at = unixepoch()
        WHERE id = ?
      `).run(
        summary.errors > 0
          ? 'partial'
          : 'imported',
        run.import_id
      )

      res.json({
        ...withActions(
          ownedRun(
            runId,
            req.session.userId
          )
        ),
        summary
      })
    } catch (error) {
      console.error(
        'Shift sync apply failed:',
        error?.message || error
      )

      res.status(
        error?.statusCode || 500
      ).json({
        error:
          error?.message ||
          'Kalendersynchronisation fehlgeschlagen'
      })
    }
  }
)

router.post(
  '/runs/:runId/rollback',
  requireAuth,
  async (req, res) => {
    try {
      const runId = integer(
        req.params.runId,
        'Sync-ID'
      )

      const run = ownedRun(
        runId,
        req.session.userId
      )

      if (!run) {
        return res.status(404).json({
          error: 'Sync-Lauf nicht gefunden'
        })
      }

      if (
        !['applied', 'partial'].includes(
          run.status
        )
      ) {
        throw exposedError(
          'Dieser Lauf kann nicht rückgängig gemacht werden'
        )
      }

      const actions = db.prepare(`
        SELECT *
        FROM shift_sync_actions
        WHERE run_id = ?
          AND status = 'applied'
        ORDER BY id DESC
      `).all(runId)

      const results = []

      for (const action of actions) {
        const oldEvent =
          parseJson(
            action.old_event_json,
            null
          )

        const newEvent =
          parseJson(
            action.new_event_json,
            null
          )

        try {
          if (action.action_type === 'create') {
            let current = null

            try {
              current =
                await getCalendarEvent(
                  req.session.userId,
                  action.event_id,
                  run.calendar_id
                )
            } catch (error) {
              if (
                ![404, 410].includes(
                  error?.statusCode
                )
              ) {
                throw error
              }
            }

            if (
              current &&
              newEvent &&
              !eventManagedEquals(
                current,
                newEvent
              )
            ) {
              throw exposedError(
                'Der erstellte Termin wurde danach manuell verändert und wird nicht gelöscht.',
                409
              )
            }

            if (current) {
              await deleteCalendarEvent(
                req.session.userId,
                {
                  eventId: action.event_id,
                  calendarId: run.calendar_id,
                  etag: current.etag || ''
                }
              )
            }

            markManagedDeleted(
              req.session.userId,
              action.event_id,
              run.calendar_id
            )
          } else if (
            action.action_type === 'update'
          ) {
            const current =
              await getCalendarEvent(
                req.session.userId,
                action.event_id,
                run.calendar_id
              )

            if (
              newEvent &&
              !eventManagedEquals(
                current,
                newEvent
              )
            ) {
              throw exposedError(
                'Der aktualisierte Termin wurde danach manuell verändert und wird nicht überschrieben.',
                409
              )
            }

            const restored =
              await updateCalendarEvent(
                req.session.userId,
                {
                  eventId: action.event_id,
                  calendarId: run.calendar_id,
                  etag: current.etag || '',
                  ...calendarPayload(
                    oldEvent,
                    run.time_zone,
                    run.calendar_id,
                    oldEvent?.reminderMinutes ??
                      run.reminder_minutes
                  )
                }
              )

            const crypto =
              await import('node:crypto')

            const fingerprint = crypto
              .createHash('sha256')
              .update([
                String(req.session.userId),
                action.work_date,
                oldEvent.start,
                oldEvent.end
              ].join('|'))
              .digest('hex')

            upsertManagedEvent(
              req.session.userId,
              fingerprint,
              restored,
              run.calendar_id
            )
          } else if (
            action.action_type === 'delete'
          ) {
            const recreated =
              await createCalendarEvent(
                req.session.userId,
                calendarPayload(
                  oldEvent,
                  run.time_zone,
                  run.calendar_id,
                  oldEvent?.reminderMinutes ??
                    run.reminder_minutes
                )
              )

            const crypto =
              await import('node:crypto')

            const fingerprint = crypto
              .createHash('sha256')
              .update([
                String(req.session.userId),
                action.work_date,
                oldEvent.start,
                oldEvent.end
              ].join('|'))
              .digest('hex')

            upsertManagedEvent(
              req.session.userId,
              fingerprint,
              recreated,
              run.calendar_id
            )

            db.prepare(`
              UPDATE shift_sync_actions
              SET event_id = ?
              WHERE id = ?
            `).run(
              recreated.id || '',
              action.id
            )
          }

          db.prepare(`
            UPDATE shift_sync_actions
            SET
              status = 'rolled_back',
              error = '',
              updated_at = unixepoch()
            WHERE id = ?
          `).run(action.id)

          results.push({
            actionId: action.id,
            status: 'rolled_back'
          })
        } catch (error) {
          const message =
            error?.message || String(error)

          db.prepare(`
            UPDATE shift_sync_actions
            SET
              status = 'rollback_error',
              error = ?,
              updated_at = unixepoch()
            WHERE id = ?
          `).run(
            message.slice(0, 1000),
            action.id
          )

          results.push({
            actionId: action.id,
            status: 'rollback_error',
            error: message
          })
        }
      }

      const errors =
        results.filter(
          item =>
            item.status === 'rollback_error'
        ).length

      const summary = {
        rolledBack:
          results.length - errors,
        rollbackErrors: errors
      }

      db.prepare(`
        UPDATE shift_sync_runs
        SET
          status = ?,
          summary_json = ?,
          rolled_back_at = unixepoch()
        WHERE id = ?
      `).run(
        errors > 0
          ? 'rollback_partial'
          : 'rolled_back',
        JSON.stringify(summary),
        runId
      )

      res.json({
        ...withActions(
          ownedRun(
            runId,
            req.session.userId
          )
        ),
        summary
      })
    } catch (error) {
      console.error(
        'Shift rollback failed:',
        error?.message || error
      )

      res.status(
        error?.statusCode || 500
      ).json({
        error:
          error?.message ||
          'Rückgängig fehlgeschlagen'
      })
    }
  }
)
export default router
