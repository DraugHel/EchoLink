import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import sharp from 'sharp'

const execFileAsync = promisify(execFile)

const MAX_PDF_BYTES =
  25 * 1024 * 1024

function clampInteger(
  value,
  fallback,
  minimum,
  maximum
) {
  const parsed = Number.parseInt(value, 10)

  if (!Number.isFinite(parsed)) {
    return fallback
  }

  return Math.min(
    Math.max(parsed, minimum),
    maximum
  )
}

function parsePageCount(output) {
  const match =
    String(output || '').match(
      /^Pages:\s+(\d+)\s*$/im
    )

  if (!match) return null

  const count =
    Number.parseInt(match[1], 10)

  return Number.isInteger(count) &&
    count > 0
    ? count
    : null
}

function renderedPageNumber(filename) {
  const match =
    String(filename).match(
      /-(\d+)\.png$/i
    )

  return match
    ? Number.parseInt(match[1], 10)
    : Number.MAX_SAFE_INTEGER
}

async function runPdfCommand(
  command,
  args,
  timeout
) {
  try {
    return await execFileAsync(
      command,
      args,
      {
        timeout,
        maxBuffer:
          4 * 1024 * 1024,
        windowsHide: true
      }
    )
  } catch (error) {
    const details =
      String(
        error?.stderr ||
        error?.message ||
        error
      ).trim()

    throw new Error(
      `${command} fehlgeschlagen: ${details}`
    )
  }
}

export async function renderPdfPagesToImages(
  buffer,
  {
    maxPages = 5,
    dpi = 144,
    maxWidth = 1600,
    maxHeight = 2200,
    jpegQuality = 82
  } = {}
) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError(
      'PDF-Inhalt muss ein Buffer sein'
    )
  }

  if (!buffer.length) {
    throw new Error(
      'PDF-Datei ist leer'
    )
  }

  if (buffer.length > MAX_PDF_BYTES) {
    throw new Error(
      'PDF überschreitet das Limit von 25 MiB'
    )
  }

  if (
    buffer
      .subarray(0, 5)
      .toString('ascii') !== '%PDF-'
  ) {
    throw new Error(
      'Datei besitzt keinen gültigen PDF-Header'
    )
  }

  const pageLimit =
    clampInteger(
      maxPages,
      5,
      1,
      10
    )

  const renderDpi =
    clampInteger(
      dpi,
      144,
      72,
      200
    )

  const imageWidth =
    clampInteger(
      maxWidth,
      1600,
      800,
      2400
    )

  const imageHeight =
    clampInteger(
      maxHeight,
      2200,
      1000,
      3200
    )

  const quality =
    clampInteger(
      jpegQuality,
      82,
      60,
      92
    )

  const temporaryDirectory =
    await fs.mkdtemp(
      path.join(
        os.tmpdir(),
        'echolink-pdf-'
      )
    )

  const pdfPath =
    path.join(
      temporaryDirectory,
      'document.pdf'
    )

  const outputPrefix =
    path.join(
      temporaryDirectory,
      'page'
    )

  try {
    await fs.writeFile(
      pdfPath,
      buffer,
      {
        mode: 0o600
      }
    )

    const info =
      await runPdfCommand(
        'pdfinfo',
        [pdfPath],
        20_000
      )

    const pageCount =
      parsePageCount(
        info.stdout
      )

    if (!pageCount) {
      throw new Error(
        'PDF-Seitenzahl konnte nicht ermittelt werden'
      )
    }

    const pagesToRender =
      Math.min(
        pageCount,
        pageLimit
      )

    await runPdfCommand(
      'pdftoppm',
      [
        '-png',
        '-f',
        '1',
        '-l',
        String(pagesToRender),
        '-r',
        String(renderDpi),
        pdfPath,
        outputPrefix
      ],
      120_000
    )

    const filenames =
      (await fs.readdir(
        temporaryDirectory
      ))
        .filter(filename =>
          /^page-\d+\.png$/i.test(
            filename
          )
        )
        .sort(
          (left, right) =>
            renderedPageNumber(left) -
            renderedPageNumber(right)
        )

    if (!filenames.length) {
      throw new Error(
        'PDF konnte nicht als Bild gerendert werden'
      )
    }

    const images = []

    for (const filename of filenames) {
      const pageNumber =
        renderedPageNumber(filename)

      const source =
        await fs.readFile(
          path.join(
            temporaryDirectory,
            filename
          )
        )

      const optimized =
        await sharp(
          source,
          {
            limitInputPixels:
              50_000_000
          }
        )
          .rotate()
          .resize({
            width: imageWidth,
            height: imageHeight,
            fit: 'inside',
            withoutEnlargement: true
          })
          .jpeg({
            quality,
            mozjpeg: true
          })
          .toBuffer()

      images.push({
        pageNumber,
        mimeType: 'image/jpeg',
        sizeBytes:
          optimized.length,
        buffer:
          optimized
      })
    }

    return {
      pageCount,
      renderedPageCount:
        images.length,
      omittedPageCount:
        Math.max(
          pageCount -
            images.length,
          0
        ),
      truncated:
        pageCount >
        images.length,
      images
    }
  } finally {
    await fs.rm(
      temporaryDirectory,
      {
        recursive: true,
        force: true
      }
    )
  }
}
