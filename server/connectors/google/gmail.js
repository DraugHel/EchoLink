import {
  getGoogleAccessToken
} from './oauth.js'

const GMAIL_API =
  'https://gmail.googleapis.com/gmail/v1'

function exposedError(message, statusCode = 500) {
  const error = new Error(message)
  error.statusCode = statusCode
  error.expose = true
  return error
}

function requiredMessageId(value) {
  const id = String(value || '').trim()

  if (!id || id.length > 1024) {
    throw exposedError(
      'Ungültige Gmail-Nachrichten-ID',
      400
    )
  }

  return id
}

function cleanQuery(value) {
  if (value == null) return ''

  if (typeof value !== 'string') {
    throw exposedError(
      'Gmail-Suchanfrage muss Text sein',
      400
    )
  }

  const query = value.trim()

  if (query.length > 2000) {
    throw exposedError(
      'Gmail-Suchanfrage ist zu lang',
      400
    )
  }

  return query
}

async function gmailRequest(
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

      const statusCode =
        response.status === 400
          ? 400
          : response.status === 403
            ? 403
            : response.status === 404
              ? 404
              : 502

      throw exposedError(
        `Gmail API: ${message}`,
        statusCode
      )
    }

    return responseBody
  }

  throw exposedError(
    'Gmail konnte nicht autorisiert werden',
    502
  )
}

function decodeBase64Url(value) {
  if (!value) return ''

  try {
    const normalized = value
      .replace(/-/g, '+')
      .replace(/_/g, '/')

    return Buffer.from(
      normalized,
      'base64'
    ).toString('utf8')
  } catch {
    return ''
  }
}

function headerValue(headers, name) {
  const target = name.toLowerCase()

  const header = (headers || []).find(
    item =>
      String(item?.name || '').toLowerCase() ===
      target
  )

  return String(header?.value || '')
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

function collectParts(part, result) {
  if (!part) return

  const mimeType =
    String(part.mimeType || '').toLowerCase()

  const data = part.body?.data
    ? decodeBase64Url(part.body.data)
    : ''

  if (mimeType === 'text/plain' && data) {
    result.plain.push(data)
  }

  if (mimeType === 'text/html' && data) {
    result.html.push(data)
  }

  const filename =
    String(part.filename || '').trim()

  if (
    filename ||
    part.body?.attachmentId
  ) {
    result.attachments.push({
      filename: filename || '(ohne Dateiname)',
      mimeType:
        part.mimeType ||
        'application/octet-stream',
      sizeBytes:
        Number(part.body?.size) || 0,
      attachmentId:
        part.body?.attachmentId || ''
    })
  }

  for (const child of part.parts || []) {
    collectParts(child, result)
  }
}

function messageSummary(message) {
  const headers =
    message.payload?.headers || []

  return {
    id: message.id,
    threadId: message.threadId,
    subject:
      headerValue(headers, 'Subject') ||
      '(Kein Betreff)',
    from: headerValue(headers, 'From'),
    to: headerValue(headers, 'To'),
    cc: headerValue(headers, 'Cc'),
    date: headerValue(headers, 'Date'),
    internalDate:
      message.internalDate
        ? new Date(
            Number(message.internalDate)
          ).toISOString()
        : null,
    snippet: String(
      message.snippet || ''
    ).slice(0, 1000),
    labels: Array.isArray(message.labelIds)
      ? message.labelIds
      : [],
    unread:
      Array.isArray(message.labelIds) &&
      message.labelIds.includes('UNREAD'),
    hasAttachments: Boolean(
      (message.payload?.parts || []).some(
        part =>
          part.filename ||
          part.body?.attachmentId
      )
    ),
    sizeEstimate:
      Number(message.sizeEstimate) || 0
  }
}

export async function searchGmailMessages(
  userId,
  {
    query = '',
    maxResults = 10
  } = {}
) {
  const limit = Math.min(
    20,
    Math.max(
      1,
      Number(maxResults) || 10
    )
  )

  const params = new URLSearchParams({
    maxResults: String(limit)
  })

  const clean = cleanQuery(query)

  if (clean) {
    params.set('q', clean)
  }

  const list = await gmailRequest(
    userId,
    `${GMAIL_API}/users/me/messages?${params}`
  )

  const messageRefs =
    Array.isArray(list.messages)
      ? list.messages
      : []

  const messages = []

  for (const item of messageRefs) {
    const metadataParams =
      new URLSearchParams({
        format: 'metadata'
      })

    for (
      const header of
      ['From', 'To', 'Cc', 'Subject', 'Date']
    ) {
      metadataParams.append(
        'metadataHeaders',
        header
      )
    }

    const message = await gmailRequest(
      userId,
      `${GMAIL_API}/users/me/messages/` +
        `${encodeURIComponent(item.id)}?` +
        metadataParams
    )

    messages.push(messageSummary(message))
  }

  return {
    query: clean,
    count: messages.length,
    resultSizeEstimate:
      Number(list.resultSizeEstimate) || 0,
    messages
  }
}

export async function readGmailMessage(
  userId,
  messageId
) {
  const id = requiredMessageId(messageId)

  const params = new URLSearchParams({
    format: 'full'
  })

  const message = await gmailRequest(
    userId,
    `${GMAIL_API}/users/me/messages/` +
      `${encodeURIComponent(id)}?${params}`
  )

  const collected = {
    plain: [],
    html: [],
    attachments: []
  }

  collectParts(
    message.payload,
    collected
  )

  const rootMimeType =
    String(
      message.payload?.mimeType || ''
    ).toLowerCase()

  const rootData =
    decodeBase64Url(
      message.payload?.body?.data
    )

  if (
    rootMimeType === 'text/plain' &&
    rootData
  ) {
    collected.plain.push(rootData)
  }

  if (
    rootMimeType === 'text/html' &&
    rootData
  ) {
    collected.html.push(rootData)
  }

  const plainBody = collected.plain
    .join('\n\n')
    .trim()

  const htmlBody = collected.html
    .join('\n\n')
    .trim()

  const body = (
    plainBody ||
    stripHtml(htmlBody) ||
    message.snippet ||
    ''
  ).slice(0, 50_000)

  return {
    ...messageSummary(message),
    body,
    bodyFormat:
      plainBody
        ? 'text/plain'
        : htmlBody
          ? 'text/html'
          : 'snippet',
    attachments:
      collected.attachments.slice(0, 50)
  }
}

function cleanMailHeader(value, name, maxLength) {
  if (typeof value !== 'string') {
    throw exposedError(
      `${name} muss Text sein`,
      400
    )
  }

  const result = value.trim()

  if (!result) {
    throw exposedError(
      `${name} darf nicht leer sein`,
      400
    )
  }

  if (/[\r\n]/.test(result)) {
    throw exposedError(
      `${name} enthält ungültige Zeilenumbrüche`,
      400
    )
  }

  if (result.length > maxLength) {
    throw exposedError(
      `${name} ist zu lang`,
      400
    )
  }

  return result
}

function optionalMailHeader(
  value,
  name,
  maxLength
) {
  if (value == null || value === '') {
    return ''
  }

  return cleanMailHeader(
    value,
    name,
    maxLength
  )
}

function cleanMailBody(value) {
  if (typeof value !== 'string') {
    throw exposedError(
      'E-Mail-Inhalt muss Text sein',
      400
    )
  }

  if (value.length > 200_000) {
    throw exposedError(
      'E-Mail-Inhalt ist zu lang',
      400
    )
  }

  return value
}

function encodeMimeHeader(value) {
  if (/^[\x20-\x7E]*$/.test(value)) {
    return value
  }

  return (
    '=?UTF-8?B?' +
    Buffer.from(value, 'utf8').toString('base64') +
    '?='
  )
}

function wrapBase64(value) {
  return value.match(/.{1,76}/g)?.join('\r\n') || ''
}

function encodeBase64Url(value) {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function buildPlainTextMime({
  to,
  cc = '',
  subject,
  body
}) {
  const headers = [
    `To: ${to}`,
    cc ? `Cc: ${cc}` : null,
    `Subject: ${encodeMimeHeader(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64'
  ].filter(Boolean)

  const encodedBody = wrapBase64(
    Buffer.from(body, 'utf8').toString('base64')
  )

  return [
    ...headers,
    '',
    encodedBody
  ].join('\r\n')
}

export async function createGmailDraft(
  userId,
  {
    to,
    cc = '',
    subject,
    body
  }
) {
  const cleanTo = cleanMailHeader(
    to,
    'Empfänger',
    2000
  )

  const cleanCc = optionalMailHeader(
    cc,
    'CC',
    2000
  )

  const cleanSubject = cleanMailHeader(
    subject,
    'Betreff',
    998
  )

  const cleanBody = cleanMailBody(body)

  const mime = buildPlainTextMime({
    to: cleanTo,
    cc: cleanCc,
    subject: cleanSubject,
    body: cleanBody
  })

  const result = await gmailRequest(
    userId,
    `${GMAIL_API}/users/me/drafts`,
    {
      method: 'POST',
      requestBody: {
        message: {
          raw: encodeBase64Url(mime)
        }
      }
    }
  )

  return {
    draftId: result.id,
    messageId: result.message?.id || null,
    threadId: result.message?.threadId || null,
    to: cleanTo,
    cc: cleanCc,
    subject: cleanSubject
  }
}

