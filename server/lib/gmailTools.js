import db from '../db.js'
import {
  createGmailDraft,
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
  }
]

export const GMAIL_TOOL_NAMES = new Set(
  GMAIL_TOOLS.map(
    tool => tool.function.name
  )
)

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

  throw new Error(
    `Unbekanntes Gmail-Tool: ${name}`
  )
}
