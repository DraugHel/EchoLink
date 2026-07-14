import {
  FIRECRAWL_TOOL,
  SEARCH_TOOL,
  firecrawlScrape,
  webSearch
} from './webSearch.js'
import { streamOllama } from '../providers/ollama.js'
import {
  splitSystemTimeNote,
  streamZai
} from '../providers/openai-compatible.js'
import { streamAnthropic } from '../providers/anthropic.js'
import { streamResponses } from '../providers/openai-responses.js'

const MAX_TOOL_ITERATIONS = 16
const MAX_TOOL_CALLS = 24
const AGENT_TIMEOUT_MS = 4 * 60 * 1000

const READ_ONLY_TOOLS = [
  SEARCH_TOOL,
  FIRECRAWL_TOOL
]

const silentResponse = {
  write() {
    return true
  }
}

function parseArguments(toolCall) {
  let args = toolCall?.function?.arguments || {}

  if (typeof args === 'string') {
    try {
      args = JSON.parse(args)
    } catch {
      args = {}
    }
  }

  return args && typeof args === 'object'
    ? args
    : {}
}

function localDateTime(timezone) {
  try {
    return new Intl.DateTimeFormat('de-AT', {
      timeZone: timezone || 'Europe/Vienna',
      dateStyle: 'full',
      timeStyle: 'long'
    }).format(new Date())
  } catch {
    return new Date().toISOString()
  }
}

function cleanFinalContent(content) {
  return String(content || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim()
}

function providerFor(model) {
  if (model.startsWith('claude')) {
    return {
      streamFn: streamAnthropic,
      providerModel: model
    }
  }

  if (model.startsWith('zai/')) {
    return {
      streamFn: streamZai,
      providerModel: model.slice(4)
    }
  }

  if (model.startsWith('openai/')) {
    return {
      streamFn: streamResponses,
      providerModel: model.slice(7)
    }
  }

  return {
    streamFn: streamOllama,
    providerModel: model
  }
}

function systemPrompt(task) {
  return [
    'You are EchoLink\'s scheduled background agent.',
    'Complete the scheduled task now and return only the finished user-facing result.',
    'Do not discuss the scheduling instruction and do not ask follow-up questions.',
    'You may use only the provided read-only web tools.',
    'Never create, update, delete, send, schedule, or execute anything.',
    'For current news, weather, warnings, gaming news, pollen data, prices, or other time-sensitive facts, perform fresh web searches during this run.',
    'For a morning briefing, search separately for world news, gaming news, local weather, and local pollen conditions.',
    'Prefer official sources and established news outlets. Cross-check important claims where practical.',
    'Include useful source links in the final answer. Never invent a source or URL.',
    'Clearly state when reliable current data could not be found.',
    `Current date and time: ${localDateTime(task.timezone)}`
  ].join('\n')
}

async function executeReadOnlyTool(
  toolCall,
  allowedUrls
) {
  const name = toolCall?.function?.name
  const args = parseArguments(toolCall)

  if (name === 'web_search') {
    const query = String(args.query || '')
      .trim()
      .slice(0, 500)

    if (!query) {
      return 'Search error: query is required'
    }

    const result = await webSearch(query)

    if (result.error) {
      return `Search error: ${result.error}`
    }

    for (const item of result.results || []) {
      if (item.source) allowedUrls.add(item.source)
    }

    return (result.results || []).map((item, index) => [
      `[${index + 1}] ${item.title}`,
      item.snippet,
      `Source: ${item.source}`
    ].filter(Boolean).join('\n')).join('\n\n')
  }

  if (name === 'firecrawl_scrape') {
    const url = String(args.url || '').trim()

    if (!allowedUrls.has(url)) {
      return 'Scrape blocked: URL was not returned by a web search in this task run.'
    }

    const result = await firecrawlScrape(url)

    if (result.error) {
      return `Scrape error: ${result.error}`
    }

    return `Content from ${url}:\n\n${result.content}`
  }

  return `Blocked tool: ${name || 'unknown'}`
}

export async function runScheduledAgent({
  task,
  conversation
}) {
  const model =
    conversation.model ||
    process.env.DEFAULT_MODEL ||
    'openai/gpt-5.6-luna'

  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(),
    AGENT_TIMEOUT_MS
  )

  const allowedUrls = new Set()
  let toolCallCount = 0
  let workingMessages = [
    {
      role: 'system',
      content: systemPrompt(task)
    },
    {
      role: 'user',
      content: task.prompt
    }
  ]

  try {
    for (
      let iteration = 0;
      iteration < MAX_TOOL_ITERATIONS;
      iteration++
    ) {
      const {
        streamFn,
        providerModel
      } = providerFor(model)

      const options = {
        temperature: conversation.temperature,
        top_k: conversation.top_k,
        top_p: conversation.top_p,
        reasoningEffort:
          conversation.reasoning_effort || '',
        tools: READ_ONLY_TOOLS
      }

      const providerMessages =
        streamFn === streamZai ||
        streamFn === streamResponses
          ? splitSystemTimeNote(workingMessages)
          : workingMessages

      const {
        fullContent,
        toolCalls,
        rawOutput
      } = await streamFn(
        providerModel,
        providerMessages,
        options,
        silentResponse,
        controller.signal
      )

      if (toolCalls?.length) {
        toolCallCount += toolCalls.length

        if (toolCallCount > MAX_TOOL_CALLS) {
          throw new Error(
            'Agent tool-call limit reached'
          )
        }

        workingMessages.push({
          role: 'assistant',
          content: fullContent || '',
          tool_calls: toolCalls,
          ...(rawOutput ? { _raw: rawOutput } : {})
        })

        for (const toolCall of toolCalls) {
          const result = await executeReadOnlyTool(
            toolCall,
            allowedUrls
          )

          workingMessages.push({
            role: 'tool',
            ...(toolCall.id
              ? { tool_call_id: toolCall.id }
              : {}),
            content: result
          })
        }

        continue
      }

      const content = cleanFinalContent(fullContent)

      if (!content) {
        throw new Error(
          'Agent returned an empty response'
        )
      }

      return content
    }

    throw new Error(
      'Agent reached the maximum tool iterations'
    )
  } finally {
    clearTimeout(timeout)
  }
}
