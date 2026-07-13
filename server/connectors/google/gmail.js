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

function cleanReplyReference(value) {
  return String(value || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 8000)
}

function cleanReplySubject(value) {
  return String(value || '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 998)
}

function buildReplyMime({
  to,
  cc = '',
  subject,
  body,
  inReplyTo,
  references
}) {
  const headers = [
    `To: ${to}`,
    cc ? `Cc: ${cc}` : null,
    `Subject: ${encodeMimeHeader(subject)}`,
    `In-Reply-To: ${inReplyTo}`,
    `References: ${references}`,
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

export async function createGmailReplyDraft(
  userId,
  {
    messageId,
    body,
    cc = ''
  }
) {
  const id = requiredMessageId(messageId)

  const original = await gmailRequest(
    userId,
    `${GMAIL_API}/users/me/messages/` +
      `${encodeURIComponent(id)}?format=full`
  )

  const headers =
    original.payload?.headers || []

  const recipient =
    headerValue(headers, 'Reply-To') ||
    headerValue(headers, 'From')

  const cleanTo = cleanMailHeader(
    recipient,
    'Antwortempfänger',
    2000
  )

  const cleanCc = optionalMailHeader(
    cc,
    'CC',
    2000
  )

  const subject = cleanReplySubject(
    headerValue(headers, 'Subject')
  )

  const originalMessageId =
    cleanReplyReference(
      headerValue(headers, 'Message-ID')
    )

  if (!originalMessageId) {
    throw exposedError(
      'Die Originalnachricht besitzt keinen Message-ID-Header',
      400
    )
  }

  const previousReferences =
    cleanReplyReference(
      headerValue(headers, 'References')
    )

  const references = [
    previousReferences,
    originalMessageId
  ].filter(Boolean).join(' ')

  const cleanBody = cleanMailBody(body)

  const mime = buildReplyMime({
    to: cleanTo,
    cc: cleanCc,
    subject,
    body: cleanBody,
    inReplyTo: originalMessageId,
    references
  })

  const result = await gmailRequest(
    userId,
    `${GMAIL_API}/users/me/drafts`,
    {
      method: 'POST',
      requestBody: {
        message: {
          raw: encodeBase64Url(mime),
          threadId: original.threadId
        }
      }
    }
  )

  return {
    draftId: result.id,
    messageId:
      result.message?.id || null,
    threadId:
      result.message?.threadId ||
      original.threadId ||
      null,
    replyToMessageId: id,
    to: cleanTo,
    cc: cleanCc,
    subject,
    sent: false
  }
}

function requiredDraftId(value) {
  const draftId = String(value || '').trim()

  if (!draftId || draftId.length > 1024) {
    throw exposedError(
      'Ungültige Gmail-Entwurfs-ID',
      400
    )
  }

  return draftId
}

function fullMessageContent(message) {
  const collected = {
    plain: [],
    html: [],
    attachments: []
  }

  collectParts(
    message.payload,
    collected
  )

  const plainBody = collected.plain
    .join('\n\n')
    .trim()

  const htmlBody = collected.html
    .join('\n\n')
    .trim()

  return {
    body: (
      plainBody ||
      stripHtml(htmlBody) ||
      message.snippet ||
      ''
    ).slice(0, 50_000),
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

export async function getGmailDraft(
  userId,
  draftId
) {
  const id = requiredDraftId(draftId)

  const draft = await gmailRequest(
    userId,
    `${GMAIL_API}/users/me/drafts/` +
      `${encodeURIComponent(id)}?format=full`
  )

  if (!draft.message) {
    throw exposedError(
      'Gmail-Entwurf enthält keine Nachricht',
      502
    )
  }

  return {
    draftId: draft.id || id,
    ...messageSummary(draft.message),
    ...fullMessageContent(draft.message)
  }
}

export async function sendGmailDraft(
  userId,
  draftId
) {
  const id = requiredDraftId(draftId)

  const message = await gmailRequest(
    userId,
    `${GMAIL_API}/users/me/drafts/send`,
    {
      method: 'POST',
      requestBody: {
        id
      }
    }
  )

  return {
    sent: true,
    draftId: id,
    ...messageSummary(message)
  }
}

function draftListLimit(value) {
  const parsed = Number.parseInt(value, 10)

  if (!Number.isFinite(parsed)) {
    return 10
  }

  return Math.min(
    Math.max(parsed, 1),
    25
  )
}

export async function listGmailDrafts(
  userId,
  {
    maxResults = 10
  } = {}
) {
  const limit = draftListLimit(maxResults)

  const listing = await gmailRequest(
    userId,
    `${GMAIL_API}/users/me/drafts?` +
      `maxResults=${limit}`
  )

  const drafts = []

  for (
    const item of listing.drafts || []
  ) {
    try {
      const draft = await getGmailDraft(
        userId,
        item.id
      )

      const body = String(
        draft.body || ''
      ).trim()

      drafts.push({
        draftId: draft.draftId,
        messageId: draft.id || null,
        threadId: draft.threadId || null,
        to: draft.to || '',
        cc: draft.cc || '',
        from: draft.from || '',
        subject: draft.subject || '',
        date: draft.date || '',
        bodyPreview:
          body.length > 1200
            ? body.slice(0, 1200) + '\n…'
            : body,
        attachments:
          draft.attachments || []
      })
    } catch (error) {
      drafts.push({
        draftId: item.id,
        error:
          error?.message || String(error)
      })
    }
  }

  return {
    drafts,
    count: drafts.length,
    resultSizeEstimate:
      listing.resultSizeEstimate || 0,
    nextPageToken:
      listing.nextPageToken || null
  }
}

export async function updateGmailDraft(
  userId,
  {
    draftId,
    to,
    cc,
    subject,
    body
  }
) {
  const id = requiredDraftId(draftId)

  const current = await gmailRequest(
    userId,
    `${GMAIL_API}/users/me/drafts/` +
      `${encodeURIComponent(id)}?format=full`
  )

  if (!current.message) {
    throw exposedError(
      'Gmail-Entwurf enthält keine Nachricht',
      502
    )
  }

  const headers =
    current.message.payload?.headers || []

  const currentContent =
    fullMessageContent(current.message)

  if (
    Array.isArray(currentContent.attachments) &&
    currentContent.attachments.length
  ) {
    throw exposedError(
      'Entwürfe mit Anhängen können noch nicht sicher bearbeitet werden',
      400
    )
  }

  const existingBcc =
    headerValue(headers, 'Bcc')

  if (existingBcc) {
    throw exposedError(
      'Entwürfe mit BCC können noch nicht sicher bearbeitet werden',
      400
    )
  }

  const nextTo = cleanMailHeader(
    to === undefined
      ? headerValue(headers, 'To')
      : to,
    'Empfänger',
    2000
  )

  const nextCc = optionalMailHeader(
    cc === undefined
      ? headerValue(headers, 'Cc')
      : cc,
    'CC',
    2000
  )

  const nextSubject = cleanReplySubject(
    subject === undefined
      ? headerValue(headers, 'Subject')
      : subject
  )

  const nextBody = cleanMailBody(
    body === undefined
      ? currentContent.body
      : body
  )

  const inReplyTo =
    cleanReplyReference(
      headerValue(headers, 'In-Reply-To')
    )

  const references =
    cleanReplyReference(
      headerValue(headers, 'References')
    )

  const mime = inReplyTo
    ? buildReplyMime({
        to: nextTo,
        cc: nextCc,
        subject: nextSubject,
        body: nextBody,
        inReplyTo,
        references:
          references || inReplyTo
      })
    : buildPlainTextMime({
        to: nextTo,
        cc: nextCc,
        subject: nextSubject,
        body: nextBody
      })

  const message = {
    raw: encodeBase64Url(mime)
  }

  if (current.message.threadId) {
    message.threadId =
      current.message.threadId
  }

  const updated = await gmailRequest(
    userId,
    `${GMAIL_API}/users/me/drafts/` +
      encodeURIComponent(id),
    {
      method: 'PUT',
      requestBody: {
        id,
        message
      }
    }
  )

  return {
    updated: true,
    sent: false,
    draftId: updated.id || id,
    messageId:
      updated.message?.id || null,
    threadId:
      updated.message?.threadId ||
      current.message.threadId ||
      null,
    to: nextTo,
    cc: nextCc,
    subject: nextSubject
  }
}

export async function deleteGmailDraft(
  userId,
  draftId
) {
  const id = requiredDraftId(draftId)

  const accessToken =
    await getGoogleAccessToken(userId)

  const response = await fetch(
    `${GMAIL_API}/users/me/drafts/` +
      encodeURIComponent(id),
    {
      method: 'DELETE',
      headers: {
        Authorization:
          `Bearer ${accessToken}`,
        Accept: 'application/json'
      }
    }
  )

  if (!response.ok) {
    const raw = await response.text()

    let details =
      raw || response.statusText

    try {
      const parsed = JSON.parse(raw)

      details =
        parsed?.error?.message ||
        parsed?.error ||
        details
    } catch {
      // Textantwort verwenden
    }

    throw exposedError(
      `Gmail-Entwurf konnte nicht gelöscht werden: ${details}`,
      response.status || 502
    )
  }

  return {
    deleted: true,
    draftId: id
  }
}

function requiredGmailResourceId(
  value,
  name
) {
  const id = String(value || '').trim()

  if (!id) {
    throw exposedError(
      `${name} fehlt`,
      400
    )
  }

  if (
    id.length > 1024 ||
    !/^[A-Za-z0-9_-]+$/.test(id)
  ) {
    throw exposedError(
      `${name} ist ungültig`,
      400
    )
  }

  return id
}

function gmailThreadMessageLimit(value) {
  const parsed = Number.parseInt(value, 10)

  if (!Number.isFinite(parsed)) {
    return 20
  }

  return Math.min(
    Math.max(parsed, 1),
    50
  )
}

export async function readGmailThread(
  userId,
  {
    messageId,
    threadId,
    maxMessages = 20
  } = {}
) {
  let resolvedThreadId = null

  if (threadId) {
    resolvedThreadId =
      requiredGmailResourceId(
        threadId,
        'Gmail-Thread-ID'
      )
  } else {
    const resolvedMessageId =
      requiredGmailResourceId(
        messageId,
        'Gmail-Nachrichten-ID'
      )

    const sourceMessage =
      await gmailRequest(
        userId,
        `${GMAIL_API}/users/me/messages/` +
          `${encodeURIComponent(
            resolvedMessageId
          )}?format=metadata`
      )

    resolvedThreadId =
      requiredGmailResourceId(
        sourceMessage.threadId,
        'Gmail-Thread-ID'
      )
  }

  const thread = await gmailRequest(
    userId,
    `${GMAIL_API}/users/me/threads/` +
      `${encodeURIComponent(
        resolvedThreadId
      )}?format=full`
  )

  const allMessages = Array.isArray(
    thread.messages
  )
    ? [...thread.messages]
    : []

  if (!allMessages.length) {
    throw exposedError(
      'Der Gmail-Thread enthält keine Nachrichten',
      502
    )
  }

  allMessages.sort(
    (left, right) =>
      Number(left.internalDate || 0) -
      Number(right.internalDate || 0)
  )

  const limit =
    gmailThreadMessageLimit(maxMessages)

  const selectedMessages =
    allMessages.slice(-limit)

  let remainingBodyCharacters = 120_000

  const messages = selectedMessages.map(
    message => {
      const content =
        fullMessageContent(message)

      let body = String(
        content.body || ''
      )

      let bodyTruncated = false

      if (body.length > 30_000) {
        body =
          body.slice(0, 30_000) +
          '\n…'

        bodyTruncated = true
      }

      if (
        body.length >
        remainingBodyCharacters
      ) {
        body =
          body.slice(
            0,
            Math.max(
              remainingBodyCharacters,
              0
            )
          ) +
          '\n…'

        bodyTruncated = true
      }

      remainingBodyCharacters =
        Math.max(
          0,
          remainingBodyCharacters -
            body.length
        )

      return {
        ...messageSummary(message),
        body,
        bodyFormat:
          content.bodyFormat,
        bodyTruncated,
        attachments:
          content.attachments || []
      }
    }
  )

  return {
    threadId:
      thread.id || resolvedThreadId,
    historyId:
      thread.historyId || null,
    messageCount:
      allMessages.length,
    returnedMessageCount:
      messages.length,
    omittedMessageCount:
      Math.max(
        allMessages.length -
          messages.length,
        0
      ),
    truncated:
      allMessages.length >
        messages.length ||
      messages.some(
        message =>
          message.bodyTruncated
      ),
    messages
  }
}

