import db from '../db.js'
import {
  listCalendarEvents
} from '../connectors/google/calendar.js'

export const CALENDAR_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'calendar_list_events',
      description:
        'Read events from the user’s primary Google Calendar. ' +
        'Use this whenever the user asks about appointments, meetings, their schedule, ' +
        'what is happening today, tomorrow, this week, or their next event. ' +
        'For relative periods, calculate explicit ISO 8601 timeMin and timeMax values. ' +
        'Default timezone is Europe/Vienna. Never invent calendar events.',
      parameters: {
        type: 'object',
        properties: {
          timeMin: {
            type: 'string',
            description:
              'Start of the requested period as an ISO 8601 timestamp, including timezone offset.'
          },
          timeMax: {
            type: 'string',
            description:
              'End of the requested period as an ISO 8601 timestamp, including timezone offset.'
          },
          maxResults: {
            type: 'integer',
            minimum: 1,
            maximum: 50,
            description:
              'Maximum number of events. Defaults to 20.'
          },
          timeZone: {
            type: 'string',
            description:
              'IANA timezone. Defaults to Europe/Vienna.'
          }
        }
      }
    }
  }
]

export const CALENDAR_TOOL_NAMES = new Set(
  CALENDAR_TOOLS.map(tool => tool.function.name)
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
    throw new Error('Unterhaltung nicht gefunden')
  }

  return {
    conversationId: conversation.id,
    userId: conversation.user_id
  }
}

export async function executeCalendarTool(
  name,
  args,
  conversationId
) {
  if (!CALENDAR_TOOL_NAMES.has(name)) {
    throw new Error(
      `Unbekanntes Kalender-Tool: ${name}`
    )
  }

  const context = getContext(conversationId)

  const result = await listCalendarEvents(
    context.userId,
    {
      timeMin: args?.timeMin,
      timeMax: args?.timeMax,
      maxResults: args?.maxResults,
      timeZone:
        args?.timeZone || 'Europe/Vienna'
    }
  )

  return JSON.stringify({
    count: result.events.length,
    timeMin: result.timeMin,
    timeMax: result.timeMax,
    timeZone: result.timeZone,
    events: result.events
  }, null, 2)
}
