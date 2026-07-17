import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import {
  fileURLToPath
} from 'node:url'

import db from '../db.js'
import { requireAuth } from '../middleware/auth.js'

const router = express.Router()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

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

function integer(
  value,
  name,
  min = 1,
  max = Number.MAX_SAFE_INTEGER
) {
  const number = Number(value)

  if (
    !Number.isSafeInteger(number) ||
    number < min ||
    number > max
  ) {
    throw exposedError(`${name} ist ungültig`)
  }

  return number
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function ownedImport(importId, userId) {
  return db.prepare(`
    SELECT *
    FROM shift_imports
    WHERE id = ?
      AND user_id = ?
  `).get(importId, userId)
}

function serializeImport(row) {
  return {
    id: row.id,
    filename: row.filename,
    originalName: row.original_name,
    columnNumber: row.column_number,
    status: row.status,
    model: row.model,
    planStart: row.plan_start,
    planEnd: row.plan_end,
    warnings:
      parseJson(row.warnings || '[]', []),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function serializeItem(row) {
  return {
    id: row.id,
    importId: row.import_id,
    workDate: row.work_date,
    code: row.code,
    startTime: row.start_time,
    endTime: row.end_time,
    title: row.title,
    confidence: row.confidence,
    note: row.note,
    enabled: Boolean(row.enabled),
    importStatus: row.import_status,
    eventId: row.event_id,
    error: row.error
  }
}

function withItems(importRow) {
  const items = db.prepare(`
    SELECT *
    FROM shift_import_items
    WHERE import_id = ?
    ORDER BY work_date, id
  `).all(importRow.id)

  return {
    import: serializeImport(importRow),
    items: items.map(serializeItem)
  }
}

function normalized(value) {
  return String(value || '')
    .trim()
    .toLocaleLowerCase('de-AT')
}

function sameShift(left, right) {
  return (
    normalized(left.code) ===
      normalized(right.code) &&
    String(left.start_time || '') ===
      String(right.start_time || '') &&
    String(left.end_time || '') ===
      String(right.end_time || '') &&
    normalized(left.title) ===
      normalized(right.title)
  )
}

function combineNotes(...values) {
  return [...new Set(
    values
      .flatMap(value =>
        String(value || '')
          .split(/\r?\n/)
      )
      .map(value => value.trim())
      .filter(Boolean)
  )].join('\n').slice(0, 1000)
}

function pageRowsForImport(importRow) {
  const pages = db.prepare(`
    SELECT
      page_number,
      filename,
      original_name
    FROM shift_import_pages
    WHERE import_id = ?
    ORDER BY page_number, id
  `).all(importRow.id)

  if (pages.length > 0) {
    return pages.map(page => ({
      filename: page.filename,
      originalName: page.original_name
    }))
  }

  return [{
    filename: importRow.filename,
    originalName: importRow.original_name
  }]
}

function referencedFilename(filename) {
  if (!filename) return false

  const direct = db.prepare(`
    SELECT 1
    FROM shift_imports
    WHERE filename = ?
    LIMIT 1
  `).get(filename)

  if (direct) return true

  return Boolean(db.prepare(`
    SELECT 1
    FROM shift_import_pages
    WHERE filename = ?
    LIMIT 1
  `).get(filename))
}

function removeFileWhenUnused(
  userId,
  filename
) {
  const clean = path.basename(
    String(filename || '')
  )

  if (!clean || clean !== filename) return
  if (referencedFilename(clean)) return

  const target = path.join(
    IMAGE_ROOT,
    String(userId),
    clean
  )

  try {
    fs.unlinkSync(target)
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn(
        'Shift page cleanup failed:',
        error?.message || error
      )
    }
  }
}

router.post('/merge', (req, res) => {
  try {
    const rawIds = Array.isArray(
      req.body?.importIds
    )
      ? req.body.importIds
      : []

    const importIds = [...new Set(
      rawIds.map(value =>
        integer(value, 'Import-ID')
      )
    )]

    if (
      importIds.length < 2 ||
      importIds.length > 10
    ) {
      throw exposedError(
        'Es müssen zwei bis zehn Fotoanalysen zusammengeführt werden'
      )
    }

    const imports = importIds.map(importId => {
      const row = ownedImport(
        importId,
        req.session.userId
      )

      if (!row) {
        throw exposedError(
          'Mindestens ein Fotoentwurf wurde nicht gefunden',
          404
        )
      }

      const hasRuns = db.prepare(`
        SELECT 1
        FROM shift_sync_runs
        WHERE import_id = ?
        LIMIT 1
      `).get(importId)

      if (hasRuns) {
        throw exposedError(
          'Bereits synchronisierte Pläne können nicht als Uploadseiten zusammengeführt werden',
          409
        )
      }

      return row
    })

    const pages = imports.flatMap(
      pageRowsForImport
    )

    if (pages.length > 10) {
      throw exposedError(
        'Der zusammengeführte Plan darf maximal zehn Fotos enthalten'
      )
    }

    const mergedByDate = new Map()
    let conflictCount = 0

    imports.forEach((importRow, importIndex) => {
      const rows = db.prepare(`
        SELECT *
        FROM shift_import_items
        WHERE import_id = ?
        ORDER BY work_date, id
      `).all(importRow.id)

      rows.forEach(row => {
        const existing =
          mergedByDate.get(row.work_date)

        if (!existing) {
          mergedByDate.set(
            row.work_date,
            {
              ...row,
              sourcePage: importIndex + 1
            }
          )
          return
        }

        if (sameShift(existing, row)) {
          if (
            Number(row.confidence) >
            Number(existing.confidence)
          ) {
            existing.code = row.code
            existing.start_time =
              row.start_time
            existing.end_time =
              row.end_time
            existing.title = row.title
            existing.confidence =
              row.confidence
          }

          existing.enabled =
            Boolean(existing.enabled) ||
            Boolean(row.enabled)
              ? 1
              : 0

          existing.note = combineNotes(
            existing.note,
            row.note
          )
          return
        }

        conflictCount += 1

        const firstText = [
          `Seite ${existing.sourcePage}`,
          existing.code || '–',
          existing.start_time || '–',
          existing.end_time || '–'
        ].join(' / ')

        const secondText = [
          `Seite ${importIndex + 1}`,
          row.code || '–',
          row.start_time || '–',
          row.end_time || '–'
        ].join(' / ')

        existing.enabled = 0
        existing.confidence = Math.min(
          Number(existing.confidence) || 0,
          Number(row.confidence) || 0,
          0.5
        )
        existing.note = combineNotes(
          existing.note,
          row.note,
          `Mehrseiten-Konflikt: ${firstText} gegenüber ${secondText}. Bitte prüfen.`
        )
      })
    })

    const mergedItems = [
      ...mergedByDate.values()
    ].sort((left, right) =>
      left.work_date.localeCompare(
        right.work_date
      )
    )

    if (mergedItems.length === 0) {
      throw exposedError(
        'Die Fotos enthalten keine zusammenführbaren Datumszeilen'
      )
    }

    const target = imports[0]

    const warnings = [
      ...new Set(
        imports.flatMap(importRow =>
          parseJson(
            importRow.warnings || '[]',
            []
          )
        )
      )
    ]

    if (conflictCount > 0) {
      warnings.push(
        `${conflictCount} Datumszeile(n) unterscheiden sich zwischen mehreren Fotos und wurden deaktiviert.`
      )
    }

    const modelNames = [
      ...new Set(
        imports
          .map(row =>
            String(row.model || '').trim()
          )
          .filter(Boolean)
      )
    ]

    const originalName =
      pages.length === 1
        ? pages[0].originalName
        : `${pages.length} Fotos: ${
            pages[0].originalName
          }${
            pages.length > 1
              ? ` + ${pages.length - 1} weitere`
              : ''
          }`

    const planStart =
      mergedItems[0].work_date
    const planEnd =
      mergedItems[
        mergedItems.length - 1
      ].work_date

    const sourceIds =
      imports.slice(1).map(row => row.id)

    const mergeTransaction =
      db.transaction(() => {
        db.prepare(`
          DELETE FROM shift_import_items
          WHERE import_id = ?
        `).run(target.id)

        db.prepare(`
          DELETE FROM shift_import_pages
          WHERE import_id = ?
        `).run(target.id)

        const insertPage = db.prepare(`
          INSERT INTO shift_import_pages (
            import_id,
            page_number,
            filename,
            original_name,
            created_at
          )
          VALUES (?, ?, ?, ?, unixepoch())
        `)

        pages.forEach((page, index) => {
          insertPage.run(
            target.id,
            index + 1,
            page.filename,
            page.originalName
          )
        })

        const insertItem = db.prepare(`
          INSERT INTO shift_import_items (
            import_id,
            work_date,
            code,
            start_time,
            end_time,
            title,
            confidence,
            note,
            enabled,
            import_status,
            event_id,
            error,
            created_at,
            updated_at
          )
          VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?,
            'pending', '', '',
            unixepoch(), unixepoch()
          )
        `)

        mergedItems.forEach(item => {
          insertItem.run(
            target.id,
            item.work_date,
            item.code || '',
            item.start_time || '',
            item.end_time || '',
            item.title || '',
            Number(item.confidence) || 0,
            item.note || '',
            item.enabled ? 1 : 0
          )
        })

        db.prepare(`
          UPDATE shift_imports
          SET
            filename = ?,
            original_name = ?,
            status = 'draft',
            model = ?,
            plan_start = ?,
            plan_end = ?,
            warnings = ?,
            archived_at = NULL,
            updated_at = unixepoch()
          WHERE id = ?
        `).run(
          pages[0].filename,
          originalName,
          modelNames.join(', '),
          planStart,
          planEnd,
          JSON.stringify(warnings),
          target.id
        )

        if (sourceIds.length > 0) {
          const placeholders =
            sourceIds.map(() => '?').join(',')

          db.prepare(`
            DELETE FROM shift_imports
            WHERE id IN (${placeholders})
          `).run(...sourceIds)
        }
      })

    mergeTransaction()

    const refreshed = ownedImport(
      target.id,
      req.session.userId
    )

    res.json({
      ...withItems(refreshed),
      pages: pages.map(
        (page, index) => ({
          pageNumber: index + 1,
          originalName: page.originalName
        })
      ),
      conflicts: conflictCount
    })
  } catch (error) {
    console.error(
      'Shift multiphoto merge failed:',
      error?.message || error
    )

    res.status(
      error?.statusCode || 500
    ).json({
      error:
        error?.message ||
        'Die Fotoanalysen konnten nicht zusammengeführt werden'
    })
  }
})

router.post('/discard', (req, res) => {
  try {
    const rawIds = Array.isArray(
      req.body?.importIds
    )
      ? req.body.importIds
      : []

    const importIds = [...new Set(
      rawIds
        .map(value => Number(value))
        .filter(Number.isSafeInteger)
        .filter(value => value > 0)
    )].slice(0, 10)

    const imports = importIds
      .map(importId =>
        ownedImport(
          importId,
          req.session.userId
        )
      )
      .filter(Boolean)
      .filter(importRow =>
        !db.prepare(`
          SELECT 1
          FROM shift_sync_runs
          WHERE import_id = ?
          LIMIT 1
        `).get(importRow.id)
      )

    const filenames = imports.flatMap(
      importRow =>
        pageRowsForImport(importRow)
          .map(page => page.filename)
    )

    const transaction = db.transaction(() => {
      for (const importRow of imports) {
        db.prepare(`
          DELETE FROM shift_imports
          WHERE id = ?
            AND user_id = ?
        `).run(
          importRow.id,
          req.session.userId
        )
      }
    })

    transaction()

    filenames.forEach(filename =>
      removeFileWhenUnused(
        req.session.userId,
        filename
      )
    )

    res.json({
      deleted: imports.length
    })
  } catch (error) {
    res.status(
      error?.statusCode || 500
    ).json({
      error:
        error?.message ||
        'Temporäre Fotoanalysen konnten nicht entfernt werden'
    })
  }
})

router.get('/:id/pages', (req, res) => {
  try {
    const importId = integer(
      req.params.id,
      'Plan-ID'
    )

    const importRow = ownedImport(
      importId,
      req.session.userId
    )

    if (!importRow) {
      return res.status(404).json({
        error: 'Schichtplan nicht gefunden'
      })
    }

    const pages = pageRowsForImport(
      importRow
    ).map((page, index) => ({
      pageNumber: index + 1,
      originalName: page.originalName
    }))

    res.json({
      importId,
      pages
    })
  } catch (error) {
    res.status(
      error?.statusCode || 500
    ).json({
      error:
        error?.message ||
        'Planseiten konnten nicht geladen werden'
    })
  }
})

router.get(
  '/:id/pages/:pageNumber/image',
  (req, res) => {
    try {
      const importId = integer(
        req.params.id,
        'Plan-ID'
      )
      const pageNumber = integer(
        req.params.pageNumber,
        'Seitennummer',
        1,
        10
      )

      const importRow = ownedImport(
        importId,
        req.session.userId
      )

      if (!importRow) {
        return res.status(404).json({
          error: 'Schichtplan nicht gefunden'
        })
      }

      const pages = pageRowsForImport(
        importRow
      )
      const page = pages[pageNumber - 1]

      if (!page) {
        return res.status(404).json({
          error: 'Planseite nicht gefunden'
        })
      }

      const filename = path.basename(
        String(page.filename || '')
      )

      if (
        !filename ||
        filename !== page.filename
      ) {
        throw exposedError(
          'Ungültiger Bilddateiname',
          500
        )
      }

      const imagePath = path.join(
        IMAGE_ROOT,
        String(req.session.userId),
        filename
      )

      if (!fs.existsSync(imagePath)) {
        return res.status(404).json({
          error: 'Bilddatei nicht gefunden'
        })
      }

      res.sendFile(imagePath)
    } catch (error) {
      res.status(
        error?.statusCode || 500
      ).json({
        error:
          error?.message ||
          'Planseite konnte nicht geladen werden'
      })
    }
  }
)

export default router
