import {
  FIRECRAWL_TOOL,
  SEARCH_TOOL,
  firecrawlScrape,
  webSearch
} from './webSearch.js'
import { streamOllama } from '../providers/ollama.js'
import {
  splitSystemTimeNote,
  streamZai,
  streamKimi
} from '../providers/openai-compatible.js'
import { streamAnthropic } from '../providers/anthropic.js'
import { streamResponses } from '../providers/openai-responses.js'

const MAX_TOOL_ITERATIONS = 16
const MAX_TOOL_CALLS = 24
const AGENT_TIMEOUT_MS = 6 * 60 * 1000
const CONTROL_POLL_MS = 750

export class AgentRunCancelledError extends Error {
  constructor(message = 'Agentenlauf wurde abgebrochen') {
    super(message)
    this.name = 'AgentRunCancelledError'
  }
}

function emitProgress(onProgress, event) {
  try {
    onProgress?.(event)
  } catch {}
}

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

  if (model.startsWith('kimi/')) {
    return {
      streamFn: streamKimi,
      providerModel: model.slice(5)
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

function finalizationPrompt(reason) {
  return [
    'Stop using tools now.',
    'Produce the best possible final user-facing answer using only the information already collected in this run.',
    'Do not ask for more data and do not mention internal tool budgets, iteration limits, or implementation details.',
    'If a section is incomplete or uncertain, say so briefly and clearly rather than omitting the entire result.',
    'Return only the finished answer.',
    `Reason for finalization: ${reason}`
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

async function callModel({
  model,
  conversation,
  workingMessages,
  tools,
  controller
}) {
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
    tools
  }

  const providerMessages =
    streamFn === streamZai ||
    streamFn === streamKimi ||
    streamFn === streamResponses
      ? splitSystemTimeNote(workingMessages)
      : workingMessages

  return streamFn(
    providerModel,
    providerMessages,
    options,
    silentResponse,
    controller.signal
  )
}

async function finalizeWithoutTools({
  model,
  conversation,
  workingMessages,
  controller,
  reason,
  onProgress
}) {
  emitProgress(onProgress, {
    type: 'finalizing',
    phase: 'finalizing',
    stepIndex: 3,
    message: 'Ergebnis wird ohne weitere Tools fertiggestellt',
    detail: reason
  })
  const finalMessages = [
    ...workingMessages,
    {
      role: 'system',
      content: finalizationPrompt(reason)
    }
  ]

  const {
    fullContent
  } = await callModel({
    model,
    conversation,
    workingMessages: finalMessages,
    tools: [],
    controller
  })

  const content = cleanFinalContent(fullContent)

  emitProgress(onProgress, {
    type: 'quality',
    phase: 'finalizing',
    stepIndex: 4,
    message: 'Abschluss und Vollständigkeit werden geprüft'
  })

  if (content) {
    return content
  }

  return [
    'Das Ergebnis konnte nur teilweise erstellt werden.',
    'Für eine verlässliche vollständige Antwort lagen nach der Recherche nicht genügend verwertbare Informationen vor.'
  ].join(' ')
}

export async function runScheduledAgent({
  task,
  conversation,
  shouldCancel,
  onProgress
}) {
  const model =
    conversation.model ||
    process.env.DEFAULT_MODEL ||
    'openai/gpt-5.6-luna'

  const controller = new AbortController()
  let abortReason = ''

  const timeout = setTimeout(() => {
    abortReason = 'timeout'
    controller.abort()
  }, AGENT_TIMEOUT_MS)

  const checkControl = () => {
    if (shouldCancel?.()) {
      abortReason = 'cancelled'
      controller.abort()
      throw new AgentRunCancelledError()
    }
  }

  const controlTimer = setInterval(() => {
    try {
      if (shouldCancel?.()) {
        abortReason = 'cancelled'
        controller.abort()
      }
    } catch {}
  }, CONTROL_POLL_MS)

  controlTimer.unref?.()

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

  emitProgress(onProgress, {
    type: 'step',
    phase: 'running',
    stepIndex: 0,
    message: 'Auftrag wird analysiert'
  })

  try {
    for (
      let iteration = 0;
      iteration < MAX_TOOL_ITERATIONS;
      iteration++
    ) {
      checkControl()

      const {
        fullContent,
        fullThinking,
        toolCalls,
        rawOutput
      } = await callModel({
        model,
        conversation,
        workingMessages,
        tools: READ_ONLY_TOOLS,
        controller
      })

      if (toolCalls?.length) {
        workingMessages.push({
          role: 'assistant',
          content: fullContent || '',
          tool_calls: toolCalls,
          ...(rawOutput ? { _raw: rawOutput } : {}),
          ...(model.startsWith('kimi/') && fullThinking
            ? { reasoning_content: fullThinking }
            : {})
        })

        emitProgress(onProgress, {
          type: 'step',
          phase: 'running',
          stepIndex: 1,
          message: 'Aktuelle Informationen werden gesammelt',
          detail: `${toolCalls.length} Tool-Aufruf${toolCalls.length === 1 ? '' : 'e'} angefordert`
        })

        const remaining = Math.max(
          0,
          MAX_TOOL_CALLS - toolCallCount
        )

        const executable = toolCalls.slice(0, remaining)
        const skipped = toolCalls.slice(remaining)

        for (const toolCall of executable) {
          checkControl()

          const toolName =
            toolCall?.function?.name || 'unknown'
          const toolArgs = parseArguments(toolCall)
          const toolDetail = String(
            toolArgs.query || toolArgs.url || ''
          ).slice(0, 500)

          emitProgress(onProgress, {
            type: 'tool_started',
            phase: 'running',
            stepIndex: 1,
            message: `${toolName} wird ausgeführt`,
            detail: toolDetail
          })

          const result = await executeReadOnlyTool(
            toolCall,
            allowedUrls
          )

          emitProgress(onProgress, {
            type: 'tool_finished',
            phase: 'running',
            stepIndex: 1,
            message: `${toolName} abgeschlossen`,
            detail: `${String(result || '').length} Zeichen Ergebnis`
          })

          workingMessages.push({
            role: 'tool',
            ...(toolCall.id
              ? { tool_call_id: toolCall.id }
              : {}),
            content: result
          })
        }

        toolCallCount += executable.length

        emitProgress(onProgress, {
          type: 'step',
          phase: 'running',
          stepIndex: 2,
          message: 'Gesammelte Informationen werden geprüft'
        })

        for (const toolCall of skipped) {
          workingMessages.push({
            role: 'tool',
            ...(toolCall.id
              ? { tool_call_id: toolCall.id }
              : {}),
            content:
              'Tool not executed: the research budget for this run is exhausted. Finish with the information already collected.'
          })
        }

        if (
          skipped.length > 0 ||
          toolCallCount >= MAX_TOOL_CALLS
        ) {
          return finalizeWithoutTools({
            model,
            conversation,
            workingMessages,
            controller,
            reason: 'research budget exhausted',
            onProgress
          })
        }

        continue
      }

      const content = cleanFinalContent(fullContent)

      if (!content) {
        return finalizeWithoutTools({
          model,
          conversation,
          workingMessages,
          controller,
          reason: 'the model returned no final text after research',
          onProgress
        })
      }

      emitProgress(onProgress, {
        type: 'step',
        phase: 'finalizing',
        stepIndex: 3,
        message: 'Nutzerfreundliches Ergebnis wird formuliert'
      })

      emitProgress(onProgress, {
        type: 'quality',
        phase: 'finalizing',
        stepIndex: 4,
        message: 'Abschluss und Vollständigkeit werden geprüft'
      })

      return content
    }

    return finalizeWithoutTools({
      model,
      conversation,
      workingMessages,
      controller,
      reason: 'maximum research iterations reached',
      onProgress
    })
  } catch (error) {
    if (abortReason === 'cancelled') {
      throw new AgentRunCancelledError()
    }

    if (abortReason === 'timeout') {
      throw new Error('Agentenlauf hat das Zeitlimit überschritten')
    }

    throw error
  } finally {
    clearTimeout(timeout)
    clearInterval(controlTimer)
  }
}
