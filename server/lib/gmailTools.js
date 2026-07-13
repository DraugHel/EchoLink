import db from '../db.js'
import {
  createGmailDraft,
  createGmailReplyDraft,
  deleteGmailDraft,
  getGmailDraft,
  listGmailDrafts,
  updateGmailDraft,
  sendGmailDraft,
  readGmailMessage,
  searchGmailMessages
} from '../connectors/google/gmail.js'

export const GMAIL_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'gmail_search_messages',
      description:
        'Search the user’s Gmail mailbox and return message summaries. ' +
        'Use Gmail search syntax such as from:, to:, subject:, is:unread, ' +
        'has:attachment, newer_than:, older_than:, after:, and before:. ' +
        'Use this tool before gmail_read_message when the message ID is unknown.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'Gmail search query. Empty string returns recent messages.'
          },
          maxResults: {
            type: 'integer',
            minimum: 1,
            maximum: 20,
            description:
              'Maximum number of messages. Defaults to 10.'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'gmail_read_message',
      description:
        'Read one Gmail message including its body, headers, labels, and attachment metadata. ' +
        'The messageId must come from gmail_search_messages.',
      parameters: {
        type: 'object',
        properties: {
          messageId: {
            type: 'string',
            description: 'Gmail message ID'
          }
        },
        required: [
          'messageId'
        ]
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'gmail_create_draft',
      description:
        'Create and save a Gmail draft. This does not send the email. ' +
        'When the user clearly asks to draft or prepare an email and the recipient, subject, and body are known, call this tool immediately. ' +
        'Do not ask for an additional confirmation because creating a draft does not send anything.',
      parameters: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description:
              'Recipient email address or comma-separated addresses.'
          },
          cc: {
            type: 'string',
            description:
              'Optional CC email address or comma-separated addresses.'
          },
          subject: {
            type: 'string',
            description: 'Email subject'
          },
          body: {
            type: 'string',
            description:
              'Plain-text email body'
          }
        },
        required: [
          'to',
          'subject',
          'body'
        ]
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'gmail_create_reply_draft',
      description:
        'Create a Gmail reply draft inside the existing email thread. ' +
        'This does not send the reply. ' +
        'Use gmail_search_messages first when the original message ID is unknown. ' +
        'When the user clearly asks to prepare or draft a reply and the reply body is known, call this tool immediately. ' +
        'Do not ask for additional confirmation because the message remains a draft.',
      parameters: {
        type: 'object',
        properties: {
          messageId: {
            type: 'string',
            description:
              'Gmail message ID being replied to.'
          },
          body: {
            type: 'string',
            description:
              'Plain-text reply body.'
          },
          cc: {
            type: 'string',
            description:
              'Optional CC email address or comma-separated addresses.'
          }
        },
        required: [
          'messageId',
          'body'
        ]
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'gmail_send_draft',
      description:
        'Send an existing Gmail draft. ' +
        'Only call this when the user explicitly asks to send the email or reply. ' +
        'The draftId must come from gmail_create_draft or gmail_create_reply_draft. ' +
        'Do not ask the user to confirm in natural language; EchoLink displays Approve and Deny buttons before sending.',
      parameters: {
        type: 'object',
        properties: {
          draftId: {
            type: 'string',
            description: 'Gmail draft ID'
          }
        },
        required: [
          'draftId'
        ]
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'gmail_list_drafts',
      description:
        'List the existing Gmail drafts. ' +
        'Use this before updating or sending a draft when its draftId is unknown. ' +
        'Do not create a duplicate draft when an existing draft can be updated.',
      parameters: {
        type: 'object',
        properties: {
          maxResults: {
            type: 'integer',
            minimum: 1,
            maximum: 25,
            description:
              'Maximum number of drafts to return. Defaults to 10.'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'gmail_update_draft',
      description:
        'Update an existing Gmail draft in place without sending it. ' +
        'Only supplied fields are changed; omitted fields remain unchanged. ' +
        'Use gmail_list_drafts first if the draftId is unknown. ' +
        'Prefer updating the existing draft instead of creating another draft.',
      parameters: {
        type: 'object',
        properties: {
          draftId: {
            type: 'string',
            description:
              'The Gmail draft ID to update.'
          },
          to: {
            type: 'string',
            description:
              'New recipient or comma-separated recipients. Omit to preserve.'
          },
          cc: {
            type: 'string',
            description:
              'New CC field. Use an empty string to clear it. Omit to preserve.'
          },
          subject: {
            type: 'string',
            description:
              'New subject. Omit to preserve.'
          },
          body: {
            type: 'string',
            description:
              'Complete new plain-text draft body. Omit to preserve.'
          }
        },
        required: [
          'draftId'
        ]
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'gmail_delete_draft',
      description:
        'Permanently delete an existing Gmail draft. ' +
        'Use gmail_list_drafts first when the draftId is unknown. ' +
        'Only call this when the user explicitly asks to delete a draft. ' +
        'Do not ask for confirmation in natural language because EchoLink displays Approve and Deny buttons.',
      parameters: {
        type: 'object',
        properties: {
          draftId: {
            type: 'string',
            description:
              'The Gmail draft ID to permanently delete.'
          }
        },
        required: [
          'draftId'
        ]
      }
    }
  }
]

export const GMAIL_TOOL_NAMES = new Set(
  GMAIL_TOOLS.map(
    tool => tool.function.name
  )
)

export const GMAIL_WRITE_TOOL_NAMES = new Set([
  'gmail_send_draft',
  'gmail_delete_draft'
])

function getContext(conversationId) {
  const id = Number(conversationId)

  if (!Number.isInteger(id) || id < 1) {
    throw new Error('Ungültige Unterhaltung')
  }

  const conversation = db.prepare(`
    SELECT id, user_id
    FROM conversations
    WHERE id = ?
  `).get(id)

  if (!conversation) {
    throw new Error(
      'Unterhaltung nicht gefunden'
    )
  }

  return {
    conversationId: conversation.id,
    userId: conversation.user_id
  }
}

function requiredMessageId(value) {
  const messageId =
    String(value || '').trim()

  if (!messageId) {
    throw new Error(
      'Gmail-Nachrichten-ID fehlt'
    )
  }

  if (messageId.length > 1024) {
    throw new Error(
      'Gmail-Nachrichten-ID ist zu lang'
    )
  }

  return messageId
}

function cleanSearchQuery(value) {
  if (value == null) return ''

  if (typeof value !== 'string') {
    throw new Error(
      'Gmail-Suchanfrage muss Text sein'
    )
  }

  const query = value.trim()

  if (query.length > 2000) {
    throw new Error(
      'Gmail-Suchanfrage ist zu lang'
    )
  }

  return query
}

function requiredDraftId(value) {
  const draftId = String(value || '').trim()

  if (!draftId) {
    throw new Error('Gmail-Entwurfs-ID fehlt')
  }

  if (draftId.length > 1024) {
    throw new Error(
      'Gmail-Entwurfs-ID ist zu lang'
    )
  }

  return draftId
}

export async function prepareGmailSendDraft(
  args,
  conversationId
) {
  const context = getContext(conversationId)
  const draftId = requiredDraftId(
    args?.draftId
  )

  const draft = await getGmailDraft(
    context.userId,
    draftId
  )

  return {
    draftId,
    draft
  }
}

export function formatGmailSendDraftPreview(
  action
) {
  const draft = action.draft
  const body = String(draft.body || '').trim()

  const bodyPreview =
    body.length > 3000
      ? body.slice(0, 3000) + '\n…'
      : body || '(Leerer Inhalt)'

  return [
    `An: ${draft.to || '(Unbekannt)'}`,
    draft.cc
      ? `CC: ${draft.cc}`
      : null,
    `Betreff: ${draft.subject || '(Kein Betreff)'}`,
    '',
    bodyPreview,
    Array.isArray(draft.attachments) &&
    draft.attachments.length
      ? `\nAnhänge: ${draft.attachments.length}`
      : null
  ].filter(Boolean).join('\n')
}

export async function prepareGmailDeleteDraft(
  args,
  conversationId
) {
  const context = getContext(conversationId)

  const draftId = requiredDraftId(
    args?.draftId
  )

  const draft = await getGmailDraft(
    context.userId,
    draftId
  )

  return {
    draftId,
    draft
  }
}

export function formatGmailDeleteDraftPreview(
  action
) {
  const draft = action.draft || {}

  const body = String(
    draft.body || ''
  ).trim()

  const bodyPreview =
    body.length > 1500
      ? body.slice(0, 1500) + '\n…'
      : body || '(Leerer Inhalt)'

  return [
    `An: ${draft.to || '(Unbekannt)'}`,
    draft.cc
      ? `CC: ${draft.cc}`
      : null,
    `Betreff: ${
      draft.subject || '(Kein Betreff)'
    }`,
    '',
    bodyPreview,
    '',
    'Dieser Entwurf wird endgültig gelöscht.'
  ].filter(Boolean).join('\n')
}

export async function executeGmailTool(
  name,
  args,
  conversationId
) {
  if (!GMAIL_TOOL_NAMES.has(name)) {
    throw new Error(
      `Unbekanntes Gmail-Tool: ${name}`
    )
  }

  const context = getContext(conversationId)

  if (name === 'gmail_search_messages') {
    const result = await searchGmailMessages(
      context.userId,
      {
        query: cleanSearchQuery(
          args?.query
        ),
        maxResults: Math.min(
          20,
          Math.max(
            1,
            Number(args?.maxResults) || 10
          )
        )
      }
    )

    return JSON.stringify(result, null, 2)
  }

  if (name === 'gmail_read_message') {
    const message = await readGmailMessage(
      context.userId,
      requiredMessageId(args?.messageId)
    )

    return JSON.stringify({
      message
    }, null, 2)
  }

  if (name === 'gmail_create_draft') {
    const draft = await createGmailDraft(
      context.userId,
      {
        to: args?.to,
        cc: args?.cc || '',
        subject: args?.subject,
        body: args?.body
      }
    )

    return JSON.stringify({
      created: true,
      sent: false,
      draft
    }, null, 2)
  }

  if (name === 'gmail_create_reply_draft') {
    const draft = await createGmailReplyDraft(
      context.userId,
      {
        messageId: args?.messageId,
        body: args?.body,
        cc: args?.cc || ''
      }
    )

    return JSON.stringify({
      created: true,
      sent: false,
      replyDraft: true,
      draft
    }, null, 2)
  }

  if (name === 'gmail_send_draft') {
    const result = await sendGmailDraft(
      context.userId,
      requiredDraftId(args?.draftId)
    )

    return JSON.stringify(result, null, 2)
  }

  if (name === 'gmail_list_drafts') {
    const result = await listGmailDrafts(
      context.userId,
      {
        maxResults: args?.maxResults
      }
    )

    return JSON.stringify(result, null, 2)
  }

  if (name === 'gmail_update_draft') {
    const result = await updateGmailDraft(
      context.userId,
      {
        draftId: args?.draftId,
        to: args?.to,
        cc: args?.cc,
        subject: args?.subject,
        body: args?.body
      }
    )

    return JSON.stringify(result, null, 2)
  }

  if (name === 'gmail_delete_draft') {
    const result = await deleteGmailDraft(
      context.userId,
      requiredDraftId(args?.draftId)
    )

    return JSON.stringify(result, null, 2)
  }

  throw new Error(
    `Unbekanntes Gmail-Tool: ${name}`
  )
}
