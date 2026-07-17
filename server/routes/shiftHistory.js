import { Router } from 'express'
import { fileURLToPath } from 'url'
import fs from 'node:fs'
import path from 'node:path'

import db from '../db.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()
const __dirname = path.dirname(
  fileURLToPath(import.meta.url)
)
const IMAGE_ROOT = path.join(
  __dirname,
  '..',
  '..',
  'data',
  'shift-imports'
)

router.use(requireAuth)

function exposedError(message, statusCode = 400) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function integer(value, name = 'ID') {
  const parsed = Number.parseInt(value, 10)

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw exposedError(`${name} ist ungültig`)
  }

  return parsed
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function ownedPlan(planId, userId) {
  return db.prepare(`
    SELECT *
    FROM shift_imports
    WHERE id = ? AND user_id = ?
  `).get(planId, userId)
}

function imagePathForPlan(plan, userId) {
  const filename = path.basename(
    String(plan.filename || '')
  )

  if (!filename || filename !== plan.filename) {
    throw exposedError(
      'Ungültiger Bilddateiname',
      500
    )
  }

  return path.join(
    IMAGE_ROOT,
    String(userId),
    filename
  )
}

function serializePlan(row) {
  return {
    id: row.id,
    originalName: row.original_name,
    columnNumber: row.column_number,
    status: row.status,
    model: row.model,
    planStart: row.plan_start,
    planEnd: row.plan_end,
    warnings:
      parseJson(row.warnings || '[]', []),
    totalItems: Number(row.total_items || 0),
    activeItems: Number(row.active_items || 0),
    uncertainItems:
      Number(row.uncertain_items || 0),
    syncRunCount:
      Number(row.sync_run_count || 0),
    latestSyncId:
      row.latest_sync_id || null,
    latestSyncStatus:
      row.latest_sync_status || '',
    latestSyncSummary:
      parseJson(
        row.latest_sync_summary || '{}',
        {}
      ),
    latestSyncAt:
      row.latest_sync_at || null,
    archivedAt: row.archived_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    hasImage: Boolean(row.filename),
    pageCount: Math.max(
      1,
      Number(row.page_count || 0)
    )
  }
}

function serializeRun(row) {
  return {
    id: row.id,
    status: row.status,
    timeZone: row.time_zone,
    calendarId: row.calendar_id || 'primary',
    reminderMinutes: row.reminder_minutes,
    summary:
      parseJson(row.summary_json || '{}', {}),
    actionCount: Number(row.action_count || 0),
    appliedCount: Number(row.applied_count || 0),
    errorCount: Number(row.error_count || 0),
    createdAt: row.created_at,
    appliedAt: row.applied_at,
    rolledBackAt: row.rolled_back_at
  }
}

function cleanupOrphanImages(userId) {
  const userDirectory = path.join(
    IMAGE_ROOT,
    String(userId)
  )

  if (!fs.existsSync(userDirectory)) {
    return {
      scanned: 0,
      deleted: 0,
      errors: []
    }
  }

  const referenced = new Set(
    db.prepare(`
      SELECT filename
      FROM shift_imports
      WHERE user_id = ?
    `).all(userId)
      .map(row => path.basename(row.filename || ''))
      .filter(Boolean)
  )

  const entries = fs.readdirSync(
    userDirectory,
    { withFileTypes: true }
  )

  let deleted = 0
  const errors = []

  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (referenced.has(entry.name)) continue

    const target = path.join(
      userDirectory,
      entry.name
    )

    try {
      fs.unlinkSync(target)
      deleted += 1
    } catch (error) {
      errors.push({
        filename: entry.name,
        error:
          error?.message || String(error)
      })
    }
  }

  return {
    scanned: entries.filter(
      entry => entry.isFile()
    ).length,
    deleted,
    errors: errors.slice(0, 20)
  }
}

router.get('/', (req, res) => {
  try {
    const archived =
      String(req.query.archived || '0') === '1'

    const archiveWhere = archived
      ? 'i.archived_at IS NOT NULL'
      : 'i.archived_at IS NULL'

    const rows = db.prepare(`
      SELECT
        i.*,
        (
          SELECT COUNT(*)
          FROM shift_import_pages page
          WHERE page.import_id = i.id
        ) AS page_count,
        (
          SELECT COUNT(*)
          FROM shift_import_items item
          WHERE item.import_id = i.id
        ) AS total_items,
        (
          SELECT COUNT(*)
          FROM shift_import_items item
          WHERE item.import_id = i.id
            AND item.enabled = 1
        ) AS active_items,
        (
          SELECT COUNT(*)
          FROM shift_import_items item
          WHERE item.import_id = i.id
            AND item.confidence < 0.85
        ) AS uncertain_items,
        (
          SELECT COUNT(*)
          FROM shift_sync_runs run
          WHERE run.import_id = i.id
        ) AS sync_run_count,
        (
          SELECT run.id
          FROM shift_sync_runs run
          WHERE run.import_id = i.id
          ORDER BY run.id DESC
          LIMIT 1
        ) AS latest_sync_id,
        (
          SELECT run.status
          FROM shift_sync_runs run
          WHERE run.import_id = i.id
          ORDER BY run.id DESC
          LIMIT 1
        ) AS latest_sync_status,
        (
          SELECT run.summary_json
          FROM shift_sync_runs run
          WHERE run.import_id = i.id
          ORDER BY run.id DESC
          LIMIT 1
        ) AS latest_sync_summary,
        (
          SELECT COALESCE(
            run.rolled_back_at,
            run.applied_at,
            run.created_at
          )
          FROM shift_sync_runs run
          WHERE run.import_id = i.id
          ORDER BY run.id DESC
          LIMIT 1
        ) AS latest_sync_at
      FROM shift_imports i
      WHERE i.user_id = ?
        AND ${archiveWhere}
      ORDER BY
        COALESCE(i.plan_start, '') DESC,
        i.id DESC
      LIMIT 100
    `).all(req.session.userId)

    res.json({
      archived,
      plans: rows.map(serializePlan)
    })
  } catch (error) {
    res.status(error?.statusCode || 500).json({
      error:
        error?.message ||
        'Schichtpläne konnten nicht geladen werden'
    })
  }
})

router.post('/cleanup', (req, res) => {
  try {
    res.json(
      cleanupOrphanImages(
        req.session.userId
      )
    )
  } catch (error) {
    res.status(error?.statusCode || 500).json({
      error:
        error?.message ||
        'Bilddateien konnten nicht bereinigt werden'
    })
  }
})

router.get('/:id/runs', (req, res) => {
  try {
    const planId = integer(
      req.params.id,
      'Plan-ID'
    )

    if (!ownedPlan(
      planId,
      req.session.userId
    )) {
      return res.status(404).json({
        error: 'Schichtplan nicht gefunden'
      })
    }

    const rows = db.prepare(`
      SELECT
        run.*,
        (
          SELECT COUNT(*)
          FROM shift_sync_actions action
          WHERE action.run_id = run.id
        ) AS action_count,
        (
          SELECT COUNT(*)
          FROM shift_sync_actions action
          WHERE action.run_id = run.id
            AND action.status IN (
              'applied',
              'rolled_back'
            )
        ) AS applied_count,
        (
          SELECT COUNT(*)
          FROM shift_sync_actions action
          WHERE action.run_id = run.id
            AND action.status IN (
              'error',
              'rollback_error'
            )
        ) AS error_count
      FROM shift_sync_runs run
      WHERE run.import_id = ?
        AND run.user_id = ?
      ORDER BY run.id DESC
      LIMIT 100
    `).all(
      planId,
      req.session.userId
    )

    res.json({
      planId,
      runs: rows.map(serializeRun)
    })
  } catch (error) {
    res.status(error?.statusCode || 500).json({
      error:
        error?.message ||
        'Sync-Verlauf konnte nicht geladen werden'
    })
  }
})

router.get('/:id/image', (req, res) => {
  try {
    const planId = integer(
      req.params.id,
      'Plan-ID'
    )

    const plan = ownedPlan(
      planId,
      req.session.userId
    )

    if (!plan) {
      return res.status(404).json({
        error: 'Schichtplan nicht gefunden'
      })
    }

    const imagePath = imagePathForPlan(
      plan,
      req.session.userId
    )

    if (!fs.existsSync(imagePath)) {
      return res.status(404).json({
        error: 'Originalfoto nicht mehr vorhanden'
      })
    }

    res.set({
      'Cache-Control':
        'private, no-store, max-age=0',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy':
        'same-origin'
    })

    res.sendFile(imagePath)
  } catch (error) {
    res.status(error?.statusCode || 500).json({
      error:
        error?.message ||
        'Originalfoto konnte nicht geladen werden'
    })
  }
})

router.post('/:id/archive', (req, res) => {
  try {
    const planId = integer(
      req.params.id,
      'Plan-ID'
    )

    const archived = Boolean(
      req.body?.archived
    )

    const result = db.prepare(`
      UPDATE shift_imports
      SET
        archived_at = ?,
        updated_at = unixepoch()
      WHERE id = ? AND user_id = ?
    `).run(
      archived ? Math.floor(Date.now() / 1000) : null,
      planId,
      req.session.userId
    )

    if (result.changes === 0) {
      return res.status(404).json({
        error: 'Schichtplan nicht gefunden'
      })
    }

    res.json({
      id: planId,
      archived
    })
  } catch (error) {
    res.status(error?.statusCode || 500).json({
      error:
        error?.message ||
        'Schichtplan konnte nicht archiviert werden'
    })
  }
})

router.delete('/:id', (req, res) => {
  try {
    const planId = integer(
      req.params.id,
      'Plan-ID'
    )

    const plan = ownedPlan(
      planId,
      req.session.userId
    )

    if (!plan) {
      return res.status(404).json({
        error: 'Schichtplan nicht gefunden'
      })
    }

    db.prepare(`
      DELETE FROM shift_imports
      WHERE id = ? AND user_id = ?
    `).run(
      planId,
      req.session.userId
    )

    let imageDeleted = false
    let imageError = ''

    try {
      const imagePath = imagePathForPlan(
        plan,
        req.session.userId
      )

      if (fs.existsSync(imagePath)) {
        fs.unlinkSync(imagePath)
        imageDeleted = true
      }
    } catch (error) {
      imageError =
        error?.message || String(error)
    }

    const cleanup = cleanupOrphanImages(
      req.session.userId
    )

    res.json({
      deleted: true,
      id: planId,
      imageDeleted,
      imageError,
      orphanImagesDeleted: cleanup.deleted,
      calendarEventsUntouched: true
    })
  } catch (error) {
    res.status(error?.statusCode || 500).json({
      error:
        error?.message ||
        'Schichtplan konnte nicht gelöscht werden'
    })
  }
})

export default router
