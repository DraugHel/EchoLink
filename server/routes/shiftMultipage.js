import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import multer from 'multer'
import {
  execFile
} from 'node:child_process'
import {
  promisify
} from 'node:util'
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

const PDF_TEMP_ROOT = path.join(
  os.tmpdir(),
  'echolink-shift-pdf'
)

const PDF_MAX_BYTES =
  25 * 1024 * 1024
const PDF_MAX_PAGES = 10
const PDF_BATCH_MAX_AGE_MS =
  60 * 60 * 1000

const execFileAsync =
  promisify(execFile)

const pdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 1,
    fileSize: PDF_MAX_BYTES
  }
})

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


function pdfBatchId(value) {
  const clean = String(value || '')
    .trim()
    .toLowerCase()

  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
      .test(clean)
  ) {
    throw exposedError(
      'Ungültige PDF-Sitzung'
    )
  }

  return clean
}

function userPdfRoot(userId) {
  return path.join(
    PDF_TEMP_ROOT,
    String(userId)
  )
}

function pdfBatchDirectory(
  userId,
  batchId
) {
  return path.join(
    userPdfRoot(userId),
    pdfBatchId(batchId)
  )
}

function removeDirectory(target) {
  try {
    fs.rmSync(
      target,
      {
        recursive: true,
        force: true
      }
    )
  } catch (error) {
    console.warn(
      'PDF temp cleanup failed:',
      error?.message || error
    )
  }
}

function cleanupOldPdfBatches() {
  fs.mkdirSync(
    PDF_TEMP_ROOT,
    { recursive: true }
  )

  const now = Date.now()

  for (
    const userEntry of fs.readdirSync(
      PDF_TEMP_ROOT,
      { withFileTypes: true }
    )
  ) {
    if (!userEntry.isDirectory()) continue

    const userDirectory = path.join(
      PDF_TEMP_ROOT,
      userEntry.name
    )

    for (
      const batchEntry of fs.readdirSync(
        userDirectory,
        { withFileTypes: true }
      )
    ) {
      if (!batchEntry.isDirectory()) continue

      const target = path.join(
        userDirectory,
        batchEntry.name
      )

      try {
        const stat = fs.statSync(target)

        if (
          now - stat.mtimeMs >
          PDF_BATCH_MAX_AGE_MS
        ) {
          removeDirectory(target)
        }
      } catch {
        removeDirectory(target)
      }
    }

    try {
      if (
        fs.readdirSync(userDirectory)
          .length === 0
      ) {
        fs.rmdirSync(userDirectory)
      }
    } catch {}
  }
}

function looksLikePdf(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length >= 5 &&
    buffer.subarray(0, 5)
      .toString('ascii') === '%PDF-'
  )
}

function pdfPageCount(stdout) {
  const match = String(stdout || '')
    .match(/^Pages:\s+(\d+)\s*$/mi)

  const pages = Number(match?.[1])

  if (
    !Number.isInteger(pages) ||
    pages < 1
  ) {
    throw exposedError(
      'Die PDF enthält keine lesbaren Seiten'
    )
  }

  if (pages > PDF_MAX_PAGES) {
    throw exposedError(
      `Die PDF hat ${pages} Seiten. Maximal ${PDF_MAX_PAGES} Seiten sind erlaubt.`
    )
  }

  return pages
}

function orderedPdfImages(directory) {
  return fs.readdirSync(directory)
    .filter(filename =>
      /^page-\d+\.jpg$/i.test(filename)
    )
    .sort((left, right) => {
      const leftNumber = Number(
        left.match(/\d+/)?.[0] || 0
      )
      const rightNumber = Number(
        right.match(/\d+/)?.[0] || 0
      )

      return leftNumber - rightNumber
    })
}

async function preparePdfUpload(req, res) {
  let batchDirectory = ''

  try {
    cleanupOldPdfBatches()

    if (!req.file?.buffer) {
      throw exposedError(
        'Bitte eine PDF-Datei auswählen'
      )
    }

    if (!looksLikePdf(req.file.buffer)) {
      throw exposedError(
        'Die ausgewählte Datei ist keine gültige PDF'
      )
    }

    const batchId = crypto.randomUUID()
    batchDirectory = pdfBatchDirectory(
      req.session.userId,
      batchId
    )

    fs.mkdirSync(
      batchDirectory,
      { recursive: true }
    )

    const inputPath = path.join(
      batchDirectory,
      'input.pdf'
    )

    fs.writeFileSync(
      inputPath,
      req.file.buffer,
      { mode: 0o600 }
    )

    let info

    try {
      info = await execFileAsync(
        'pdfinfo',
        [inputPath],
        {
          timeout: 20_000,
          maxBuffer:
            2 * 1024 * 1024
        }
      )
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw exposedError(
          'pdfinfo ist auf dem Server nicht installiert',
          503
        )
      }

      throw exposedError(
        'Die PDF konnte nicht gelesen werden. Passwortgeschützte oder beschädigte PDFs werden nicht unterstützt.'
      )
    }

    const pageCount =
      pdfPageCount(info.stdout)

    const outputPrefix = path.join(
      batchDirectory,
      'page'
    )

    try {
      await execFileAsync(
        'pdftoppm',
        [
          '-jpeg',
          '-scale-to',
          '2400',
          '-jpegopt',
          'quality=85',
          '-f',
          '1',
          '-l',
          String(pageCount),
          inputPath,
          outputPrefix
        ],
        {
          timeout: 120_000,
          maxBuffer:
            4 * 1024 * 1024
        }
      )
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw exposedError(
          'pdftoppm ist auf dem Server nicht installiert',
          503
        )
      }

      throw exposedError(
        'Die PDF-Seiten konnten nicht in Bilder umgewandelt werden'
      )
    } finally {
      try {
        fs.unlinkSync(inputPath)
      } catch {}
    }

    const images =
      orderedPdfImages(batchDirectory)

    if (images.length !== pageCount) {
      throw exposedError(
        'Nicht alle PDF-Seiten konnten vorbereitet werden'
      )
    }

    let totalBytes = 0

    images.forEach(filename => {
      const target = path.join(
        batchDirectory,
        filename
      )

      const size =
        fs.statSync(target).size

      if (
        size < 1 ||
        size > 10 * 1024 * 1024
      ) {
        throw exposedError(
          'Mindestens eine PDF-Seite ist nach der Umwandlung zu groß'
        )
      }

      totalBytes += size
    })

    if (
      totalBytes >
      40 * 1024 * 1024
    ) {
      throw exposedError(
        'Die umgewandelten PDF-Seiten sind zusammen zu groß'
      )
    }

    res.json({
      batchId,
      originalName:
        String(
          req.file.originalname ||
          'Schichtplan.pdf'
        ).slice(0, 300),
      pageCount,
      pages: images.map(
        (_, index) => ({
          pageNumber: index + 1,
          url:
            `/api/shift-multipage/pdf/${batchId}/${index + 1}`
        })
      )
    })
  } catch (error) {
    if (batchDirectory) {
      removeDirectory(batchDirectory)
    }

    res.status(
      error?.statusCode || 500
    ).json({
      error:
        error?.message ||
        'PDF konnte nicht vorbereitet werden'
    })
  }
}


router.post(
  '/pdf/prepare',
  (req, res) => {
    pdfUpload.single('pdf')(
      req,
      res,
      error => {
        if (error) {
          const status =
            error?.code ===
            'LIMIT_FILE_SIZE'
              ? 413
              : 400

          return res.status(status).json({
            error:
              error?.code ===
              'LIMIT_FILE_SIZE'
                ? 'Die PDF darf maximal 25 MB groß sein'
                : error?.message ||
                  'PDF-Upload fehlgeschlagen'
          })
        }

        preparePdfUpload(req, res)
      }
    )
  }
)

router.get(
  '/pdf/:batchId/:pageNumber',
  (req, res) => {
    try {
      const batchId = pdfBatchId(
        req.params.batchId
      )

      const pageNumber = integer(
        req.params.pageNumber,
        'PDF-Seite',
        1,
        PDF_MAX_PAGES
      )

      const target = path.join(
        pdfBatchDirectory(
          req.session.userId,
          batchId
        ),
        `page-${pageNumber}.jpg`
      )

      if (!fs.existsSync(target)) {
        return res.status(404).json({
          error:
            'Vorbereitete PDF-Seite nicht gefunden'
        })
      }

      res.set(
        'Cache-Control',
        'private, no-store'
      )
      res.type('image/jpeg')
      res.sendFile(target)
    } catch (error) {
      res.status(
        error?.statusCode || 500
      ).json({
        error:
          error?.message ||
          'PDF-Seite konnte nicht geladen werden'
      })
    }
  }
)

router.delete(
  '/pdf/:batchId',
  (req, res) => {
    try {
      const batchId = pdfBatchId(
        req.params.batchId
      )

      removeDirectory(
        pdfBatchDirectory(
          req.session.userId,
          batchId
        )
      )

      res.json({
        deleted: true
      })
    } catch (error) {
      res.status(
        error?.statusCode || 500
      ).json({
        error:
          error?.message ||
          'PDF-Zwischendaten konnten nicht entfernt werden'
      })
    }
  }
)

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
