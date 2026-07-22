import path from 'node:path'

export const MAX_UPLOAD_FILES = 5
export const MAX_UPLOAD_FILE_BYTES =
  25 * 1024 * 1024
export const MAX_UPLOAD_IMAGE_PIXELS =
  40 * 1000 * 1000
export const MAX_UPLOAD_ORIGINAL_NAME_CHARS = 255

const IMAGE_MIME_BY_EXTENSION = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp']
])

const TEXT_EXTENSIONS = new Set([
  '.zip', '.tar', '.gz', '.7z', '.rar',
  '.docx', '.xlsx', '.xls', '.pptx',
  '.txt', '.md', '.csv', '.json', '.xml',
  '.html', '.css', '.js', '.jsx', '.ts',
  '.tsx', '.py', '.rb', '.go', '.rs',
  '.java', '.c', '.cpp', '.h', '.hpp',
  '.sh', '.bash', '.yml', '.yaml', '.toml',
  '.ini', '.conf', '.log', '.sql', '.php',
  '.swift', '.kt'
])

const ARCHIVE_EXTENSIONS = new Set([
  '.zip', '.tar', '.gz', '.7z', '.rar'
])

const OFFICE_TEXT_EXTENSIONS = new Set([
  '.docx', '.xlsx', '.xls', '.pptx'
])

const SAFE_STORED_FILENAME =
  /^[a-z0-9][a-z0-9_.-]{0,180}$/i

export function uploadExtension(filename) {
  return path.extname(
    String(filename || '')
  ).toLowerCase()
}

export function isImage(filename) {
  return IMAGE_MIME_BY_EXTENSION.has(
    uploadExtension(filename)
  )
}

export function validateUploadOriginalName(value) {
  if (typeof value !== 'string') {
    throw new Error('Dateiname fehlt')
  }

  const filename = value.trim()

  if (
    !filename ||
    filename.length >
      MAX_UPLOAD_ORIGINAL_NAME_CHARS ||
    /[\u0000-\u001f\u007f]/.test(filename) ||
    /[\\/]/.test(filename)
  ) {
    throw new Error('Dateiname ist ungültig')
  }

  return filename
}

export function uploadAccepted(
  originalName,
  mimeType
) {
  let filename

  try {
    filename = validateUploadOriginalName(
      originalName
    )
  } catch {
    return false
  }

  const extension = uploadExtension(filename)
  const expectedImageMime =
    IMAGE_MIME_BY_EXTENSION.get(extension)

  if (expectedImageMime) {
    const normalizedMime = String(
      mimeType || ''
    ).toLowerCase()

    return normalizedMime === expectedImageMime ||
      (
        extension === '.jpg' &&
        normalizedMime === 'image/jpg'
      )
  }

  return extension === '.pdf' ||
    TEXT_EXTENSIONS.has(extension)
}

export function getUploadKind(filename) {
  const extension = uploadExtension(filename)

  if (IMAGE_MIME_BY_EXTENSION.has(extension)) {
    return 'image'
  }

  if (extension === '.pdf') return 'pdf'
  if (ARCHIVE_EXTENSIONS.has(extension)) {
    return 'archive'
  }

  if (OFFICE_TEXT_EXTENSIONS.has(extension)) {
    return 'text'
  }

  return 'text'
}

export function isSafeStoredUploadFilename(value) {
  return typeof value === 'string' &&
    SAFE_STORED_FILENAME.test(value) &&
    !value.includes('..')
}

export function uploadResponseHeaders(filename) {
  const extension = uploadExtension(filename)
  const imageMime =
    IMAGE_MIME_BY_EXTENSION.get(extension)
  const inline = Boolean(imageMime)

  return {
    'Cache-Control':
      'private, no-store, max-age=0',
    Pragma: 'no-cache',
    'Content-Type': inline
      ? imageMime
      : 'application/octet-stream',
    'Content-Disposition': inline
      ? 'inline'
      : 'attachment',
    'Content-Security-Policy': [
      'sandbox',
      "default-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'"
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy':
      'same-origin'
  }
}
