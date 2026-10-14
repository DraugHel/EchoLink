import { ALL_TOOLS } from '../lib/toolRegistry.js'
import { imgMediaType } from '../lib/images.js'
import {
  fetchProviderStream,
  markProviderError,
  streamFailure
} from './streamErrors.js'

// ===================== Google Gemini API Provider =====================
// Native Gemini API (generateContent / streamGenerateContent, SSE).
// Modelle laufen als "google/<modell>", z.B. google/gemini-3.6-flash.
export const GEMINI_KEY = process.env.GEMINI_API_KEY || ''
export const GEMINI_BASE_URL = (
  process.env.GEMINI_BASE_URL ||
  'https://generativelanguage.googleapis.com/v1beta'
).replace(/\/+$/, '')

const DEFAULT_MAX_OUTPUT_TOKENS = Math.max(
  1024,
  Number.parseInt(process.env.GEMINI_MAX_OUTPUT_TOKENS, 10) || 32768
)

// ----- Modellfamilien -----

// gemini-3.6-flash -> { major: 3, minor: 6 }, gemini-2.5-pro -> { 2, 5 }
export function geminiGeneration(model) {
  const match = /^gemini-(\d+)(?:\.(\d+))?/.exec(
    String(model || '').toLowerCase()
  )

  return match
    ? { major: Number(match[1]), minor: Number(match[2] || 0) }
    : { major: 0, minor: 0 }
}

function isProModel(model) {
  return /-pro(?:-|$)/.test(String(model || '').toLowerCase())
}

// Gemini 3 und neuer: Google empfiehlt die Standard-Sampling-Werte
// (Temperatur 1,0). Eigene Werte koennen die Antwortqualitaet verschlechtern,
// deshalb werden sie dort nicht gesendet (GEMINI_SAMPLING_PARAMS=1 erzwingt es).
export function sendsSamplingParams(model, env = process.env) {
  if (/^(1|true|on|yes)$/i.test(String(env.GEMINI_SAMPLING_PARAMS || ''))) {
    return true
  }

  return geminiGeneration(model).major < 3
}

// Denkmodus von EchoLink ('', off, low, medium, high, max) -> thinkingConfig.
//  - Gemini 3+: thinkingLevel (minimal/low/medium/high)
//  - Gemini 2.5: thinkingBudget (Tokens)
//  - aeltere Modelle: kein Denken
// includeThoughts liefert die Denk-Zusammenfassung fuer die Anzeige.
export function thinkingConfigFor(model, effort) {
  const level = String(effort || '').toLowerCase()
  const { major, minor } = geminiGeneration(model)
  const pro = isProModel(model)

  if (major >= 3) {
    if (level === '') return { includeThoughts: true }

    if (level === 'off') {
      // Pro-Modelle lassen sich nicht ganz abschalten.
      return {
        thinkingLevel: pro ? 'low' : 'minimal',
        includeThoughts: false
      }
    }

    const thinkingLevel =
      level === 'low'
        ? 'low'
        : level === 'medium'
          ? 'medium'
          : 'high'

    return { thinkingLevel, includeThoughts: true }
  }

  if (major === 2 && minor >= 5) {
    if (level === '') return { includeThoughts: true }

    if (level === 'off') {
      return { thinkingBudget: pro ? 128 : 0, includeThoughts: false }
    }

    const budgets = {
      low: 1024,
      medium: 8192,
      high: 24576,
      xhigh: pro ? 32768 : 24576,
      max: pro ? 32768 : 24576
    }

    return {
      thinkingBudget: budgets[level] ?? 8192,
      includeThoughts: true
    }
  }

  return null
}

// ----- Schema (OpenAPI-Teilmenge) -----

const SCHEMA_TYPES = new Set([
  'string',
  'number',
  'integer',
  'boolean',
  'array',
  'object'
])

const ALLOWED_FORMATS = {
  string: new Set(['enum', 'date-time']),
  integer: new Set(['int32', 'int64']),
  number: new Set(['float', 'double'])
}

const MAX_SCHEMA_DEPTH = 8

function mergeAllOf(node) {
  const merged = { ...node }

  delete merged.allOf

  for (const part of node.allOf) {
    if (!part || typeof part !== 'object') continue

    for (const [key, value] of Object.entries(part)) {
      if (key === 'properties') {
        merged.properties = { ...(merged.properties || {}), ...value }
      } else if (key === 'required') {
        merged.required = [
          ...new Set([...(merged.required || []), ...value])
        ]
      } else if (!(key in merged)) {
        merged[key] = value
      }
    }
  }

  return merged
}

function resolveRef(ref, root) {
  const match = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(String(ref))

  if (!match) return null

  const bag = root?.$defs || root?.definitions

  return bag?.[match[1]] || null
}

// Wandelt ein JSON-Schema in die von Gemini unterstuetzte Teilmenge um:
// keine additionalProperties/default/$ref, Format-Whitelist, Enums nur als Text.
export function geminiSchema(node, root = node, depth = 0) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    return { type: 'STRING' }
  }

  if (depth > MAX_SCHEMA_DEPTH) return { type: 'STRING' }

  let schema = node

  if (schema.$ref) {
    const target = resolveRef(schema.$ref, root)

    schema = target
      ? { ...target, ...(schema.description ? { description: schema.description } : {}) }
      : { type: 'string' }
  }

  if (Array.isArray(schema.allOf)) schema = mergeAllOf(schema)

  const variants = schema.anyOf || schema.oneOf

  if (Array.isArray(variants) && variants.length) {
    const nonNull = variants.filter(item => item?.type !== 'null')
    const nullable = nonNull.length !== variants.length

    if (nonNull.length === 0) return { type: 'STRING', nullable: true }

    if (nonNull.length === 1) {
      return {
        ...geminiSchema(
          { ...nonNull[0], description: nonNull[0].description || schema.description },
          root,
          depth + 1
        ),
        ...(nullable ? { nullable: true } : {})
      }
    }

    return {
      anyOf: nonNull.map(item => geminiSchema(item, root, depth + 1)),
      ...(schema.description ? { description: String(schema.description) } : {}),
      ...(nullable ? { nullable: true } : {})
    }
  }

  let nullable = schema.nullable === true
  let type = schema.type

  if (Array.isArray(type)) {
    nullable = nullable || type.includes('null')

    const kinds = type.filter(item => item !== 'null')

    if (kinds.length > 1) {
      return {
        anyOf: kinds.map(kind =>
          geminiSchema({ ...schema, type: kind }, root, depth + 1)
        ),
        ...(nullable ? { nullable: true } : {})
      }
    }

    type = kinds[0]
  }

  if (!SCHEMA_TYPES.has(type)) {
    type = schema.properties
      ? 'object'
      : schema.items
        ? 'array'
        : 'string'
  }

  const out = { type: type.toUpperCase() }
  let description = schema.description ? String(schema.description) : ''

  if (nullable) out.nullable = true

  if (type === 'object') {
    const properties = {}

    for (const [name, child] of Object.entries(schema.properties || {})) {
      if (name) properties[name] = geminiSchema(child, root, depth + 1)
    }

    if (Object.keys(properties).length === 0) {
      // Freie Objekte kennt Gemini nicht: als JSON-Text beschreiben.
      return {
        type: 'STRING',
        description:
          (description ? description + ' ' : '') + '(JSON-Objekt als Text)',
        ...(nullable ? { nullable: true } : {})
      }
    }

    out.properties = properties

    const required = (schema.required || []).filter(name => name in properties)

    if (required.length) out.required = required
  } else if (type === 'array') {
    out.items = geminiSchema(schema.items, root, depth + 1)

    if (Number.isInteger(schema.minItems)) out.minItems = schema.minItems
    if (Number.isInteger(schema.maxItems)) out.maxItems = schema.maxItems
  } else {
    const values = Array.isArray(schema.enum)
      ? schema.enum
      : schema.const !== undefined
        ? [schema.const]
        : null

    if (values && values.length) {
      if (type === 'string') {
        out.enum = values.map(String)
      } else {
        description +=
          (description ? ' ' : '') + `(erlaubt: ${values.join(', ')})`
      }
    }

    if (
      typeof schema.format === 'string' &&
      ALLOWED_FORMATS[type]?.has(schema.format)
    ) {
      out.format = schema.format
    }

    if (type === 'number' || type === 'integer') {
      if (typeof schema.minimum === 'number') out.minimum = schema.minimum
      if (typeof schema.maximum === 'number') out.maximum = schema.maximum
    }
  }

  if (description) out.description = description

  return out
}

export function geminiTools(tools = ALL_TOOLS) {
  const declarations = []

  for (const tool of tools || []) {
    const fn = tool?.function

    if (!fn?.name) continue

    const parameters = fn.parameters
      ? geminiSchema(fn.parameters)
      : null

    declarations.push({
      name: fn.name,
      description: String(fn.description || ''),
      // Ohne Parameter: kein "parameters"-Feld (leere Objekte lehnt Gemini ab).
      ...(parameters?.type === 'OBJECT' && parameters.properties
        ? { parameters }
        : {})
    })
  }

  return declarations.length ? [{ functionDeclarations: declarations }] : []
}

// ----- Nachrichten -----

const RAW_MARKER = 'gemini'

export function isGeminiRaw(raw) {
  return (
    raw?.provider === RAW_MARKER &&
    Array.isArray(raw.parts) &&
    raw.parts.length > 0
  )
}

function copyParts(parts) {
  return parts.map(part => JSON.parse(JSON.stringify(part)))
}

function isPlain(content) {
  return content.parts.every(
    part => !part.functionCall && !part.functionResponse
  )
}

// EchoLink-Nachrichten -> { systemInstruction, contents }.
// Gemini 3 verlangt, dass die Denk-Signaturen (thoughtSignature) der
// Modellantwort bei Funktionsaufrufen unveraendert zurueckgehen: Dafuer
// bringt streamGemini die rohen Teile als _raw mit, hier werden sie 1:1
// wieder eingesetzt.
export function toGemini(messages) {
  const systemTexts = []
  const contents = []
  const callNames = new Map()
  const callApiIds = new Map()
  let pending = []

  const rememberCalls = calls => {
    pending = []

    for (const call of calls || []) {
      if (!call?.id) continue

      callNames.set(call.id, call.function?.name || 'tool')

      if (call.geminiCallId) callApiIds.set(call.id, call.geminiCallId)

      pending.push(call.id)
    }
  }

  for (const message of messages || []) {
    if (message.role === 'system') {
      if (message.content) systemTexts.push(String(message.content))
      continue
    }

    if (message.role === 'assistant') {
      if (isGeminiRaw(message._raw)) {
        contents.push({ role: 'model', parts: copyParts(message._raw.parts) })
        rememberCalls(message.tool_calls)
        continue
      }

      if (message.tool_calls?.length) {
        const parts = []

        if (message.content) parts.push({ text: String(message.content) })

        for (const call of message.tool_calls) {
          let args = call.function?.arguments ?? {}

          if (typeof args === 'string') {
            try { args = JSON.parse(args) } catch { args = {} }
          }

          parts.push({
            functionCall: {
              name: call.function?.name || 'tool',
              args: args && typeof args === 'object' ? args : {}
            }
          })
        }

        contents.push({ role: 'model', parts })
        rememberCalls(message.tool_calls)
        continue
      }

      if (message.content) {
        contents.push({
          role: 'model',
          parts: [{ text: String(message.content) }]
        })
      }

      continue
    }

    if (message.role === 'tool') {
      const id = message.tool_call_id
      let name = message.tool_name || (id && callNames.get(id))

      if (!name) {
        const next = pending.shift()

        name = (next && callNames.get(next)) || 'tool'
      } else if (id) {
        pending = pending.filter(item => item !== id)
      }

      const apiId = id ? callApiIds.get(id) : undefined
      const part = {
        functionResponse: {
          name,
          ...(apiId ? { id: apiId } : {}),
          response: { result: String(message.content ?? '') }
        }
      }
      const last = contents[contents.length - 1]

      if (
        last?.role === 'user' &&
        last.parts.every(item => item.functionResponse)
      ) {
        last.parts.push(part)
      } else {
        contents.push({ role: 'user', parts: [part] })
      }

      continue
    }

    // user
    const parts = []

    for (const image of message.images || []) {
      parts.push({
        inlineData: { mimeType: imgMediaType(image), data: image }
      })
    }

    if (message.content) parts.push({ text: String(message.content) })

    if (parts.length === 0) continue

    contents.push({ role: 'user', parts })
  }

  // Aufeinanderfolgende gleiche Rollen zusammenfassen (Gemini erwartet
  // abwechselnde Beitraege), Funktionsaufrufe/-antworten bleiben unangetastet.
  const merged = []

  for (const content of contents) {
    const last = merged[merged.length - 1]

    if (
      last &&
      last.role === content.role &&
      isPlain(last) &&
      isPlain(content)
    ) {
      last.parts.push(...content.parts)
    } else {
      merged.push(content)
    }
  }

  // Das Gespraech muss mit einem Nutzer-Beitrag beginnen ...
  if (merged[0]?.role === 'model') {
    merged.unshift({
      role: 'user',
      parts: [{ text: '(Der Anfang des Gespraechs wurde gekuerzt.)' }]
    })
  }

  // ... und darf nicht mit einem Modell-Beitrag enden (neuere Modelle
  // lehnen "Prefill" mit HTTP 400 ab).
  if (merged.length && merged[merged.length - 1].role === 'model') {
    merged.push({ role: 'user', parts: [{ text: 'Bitte fahre fort.' }] })
  }

  return {
    systemInstruction: systemTexts.length
      ? { parts: [{ text: systemTexts.join('\n\n') }] }
      : undefined,
    contents: merged
  }
}

// ----- Modellliste -----

const NON_CHAT_MODEL = /(embedding|tts|image|audio|live|robotics|computer-use|deep-research|aqa|imagen|veo)/i

export function normalizeGeminiModels(data) {
  return (data?.models || [])
    .filter(model =>
      typeof model?.name === 'string' &&
      model.name.startsWith('models/gemini-') &&
      (!Array.isArray(model.supportedGenerationMethods) ||
        model.supportedGenerationMethods.includes('generateContent')) &&
      !NON_CHAT_MODEL.test(model.name)
    )
    .map(model => model.name.slice('models/'.length))
    .sort()
    .reverse()
    .map(id => ({ name: `google/${id}`, provider: 'google' }))
}

// ----- Streaming -----

const MODELS_WITHOUT_THINKING = new Set()
const MODELS_WITHOUT_SAMPLING = new Set()

function isUnsupported(error, pattern) {
  const message = String(error?.message || '')

  return (
    pattern.test(message) &&
    /not supported|unsupported|invalid|unknown|not enabled|not allowed|cannot|can't|deprecated/i.test(message)
  )
}

const THINKING_ERROR = /thinking|thinkingConfig|thinking_level|thinkingLevel|thinking_budget|thinkingBudget|includeThoughts/i
const SAMPLING_ERROR = /temperature|topP|top_p|topK|top_k/i

const BLOCKED_FINISH = new Set([
  'SAFETY',
  'PROHIBITED_CONTENT',
  'BLOCKLIST',
  'SPII',
  'IMAGE_SAFETY',
  'RECITATION',
  'LANGUAGE'
])

const GLITCH_FINISH = new Set([
  'MALFORMED_FUNCTION_CALL',
  'UNEXPECTED_TOOL_CALL',
  'TOO_MANY_TOOL_CALLS'
])

export function buildGeminiBody(model, messages, options = {}) {
  const { systemInstruction, contents } = toGemini(messages)
  const generationConfig = {
    maxOutputTokens: options?.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
  }

  if (sendsSamplingParams(model) && !MODELS_WITHOUT_SAMPLING.has(model)) {
    if (options?.temperature != null) {
      generationConfig.temperature = Math.min(
        Math.max(Number(options.temperature), 0),
        2
      )
    }

    if (options?.top_p != null) generationConfig.topP = Number(options.top_p)

    if (Number.isInteger(options?.top_k) && options.top_k > 0) {
      generationConfig.topK = options.top_k
    }
  }

  const thinking = MODELS_WITHOUT_THINKING.has(model)
    ? null
    : thinkingConfigFor(model, options?.reasoningEffort)

  if (thinking) generationConfig.thinkingConfig = thinking

  const tools = geminiTools(options?.tools ?? ALL_TOOLS)

  return {
    ...(systemInstruction ? { systemInstruction } : {}),
    contents,
    ...(tools.length ? { tools } : {}),
    generationConfig
  }
}

function appendRawPart(rawParts, part) {
  const last = rawParts[rawParts.length - 1]
  const plainText =
    typeof part.text === 'string' &&
    !part.functionCall &&
    !part.thoughtSignature

  // Text-Brocken derselben Art zu einem Teil zusammenfuegen; Teile mit
  // Signatur oder Funktionsaufruf bleiben exakt so, wie sie kamen.
  if (
    plainText &&
    last &&
    typeof last.text === 'string' &&
    !last.functionCall &&
    !last.thoughtSignature &&
    Boolean(last.thought) === Boolean(part.thought)
  ) {
    last.text += part.text
    return
  }

  rawParts.push({ ...part })
}

// Gleiches Interface wie die anderen Provider:
// { fullContent, fullThinking, toolCalls, tokenUsage, rawOutput, completed }
export async function streamGemini(model, messages, options, res, abortSignal) {
  if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY fehlt in der .env')

  const url =
    `${GEMINI_BASE_URL}/models/${encodeURIComponent(model)}` +
    ':streamGenerateContent?alt=sse'

  const send = body => fetchProviderStream(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': GEMINI_KEY
    },
    body: JSON.stringify(body),
    signal: abortSignal
  }, 'Gemini')

  let body = buildGeminiBody(model, messages, options)
  let response

  // Lehnt das Modell Denk- oder Sampling-Parameter ab, wird einmal ohne sie
  // wiederholt und das Modell gemerkt (aelteres/anderes Modell als erwartet).
  for (let attempt = 0; ; attempt++) {
    try {
      response = await send(body)
      break
    } catch (error) {
      const config = body.generationConfig || {}
      const rejectedThinking =
        config.thinkingConfig && isUnsupported(error, THINKING_ERROR)
      const rejectedSampling =
        (config.temperature !== undefined ||
          config.topP !== undefined ||
          config.topK !== undefined) &&
        isUnsupported(error, SAMPLING_ERROR)

      if (attempt >= 2 || (!rejectedThinking && !rejectedSampling)) {
        throw error
      }

      if (rejectedThinking) {
        MODELS_WITHOUT_THINKING.add(model)
        delete config.thinkingConfig
        console.warn(JSON.stringify({
          level: 'warn',
          event: 'gemini_thinking_rejected',
          model
        }))
      } else {
        MODELS_WITHOUT_SAMPLING.add(model)
        delete config.temperature
        delete config.topP
        delete config.topK
        console.warn(JSON.stringify({
          level: 'warn',
          event: 'gemini_sampling_rejected',
          model
        }))
      }
    }
  }

  let fullContent = ''
  let fullThinking = ''
  const rawParts = []
  const toolCalls = []
  let usage = null
  let finishReason = ''
  let buffer = ''
  let streamCompleted = false
  const decoder = new TextDecoder()

  const handleEvent = event => {
    if (event?.error) {
      const status = String(event.error.status || '')
      const code = Number(event.error.code) || 0

      throw markProviderError(
        new Error(event.error.message || 'Gemini stream error'),
        {
          retryable:
            code >= 500 ||
            code === 429 ||
            ['UNAVAILABLE', 'RESOURCE_EXHAUSTED', 'INTERNAL', 'DEADLINE_EXCEEDED'].includes(status)
        }
      )
    }

    if (event?.promptFeedback?.blockReason) {
      throw markProviderError(
        new Error(
          `Gemini hat die Anfrage blockiert (${event.promptFeedback.blockReason}).`
        ),
        { retryable: false }
      )
    }

    if (event?.usageMetadata) usage = event.usageMetadata

    const candidate = event?.candidates?.[0]

    if (!candidate) return

    for (const part of candidate.content?.parts || []) {
      if (part.functionCall) {
        const callName = part.functionCall.name || 'tool'
        const apiId = part.functionCall.id || undefined
        const id = apiId || `call_gemini_${toolCalls.length}_${Date.now().toString(36)}`

        toolCalls.push({
          id,
          ...(apiId ? { geminiCallId: apiId } : {}),
          function: {
            name: callName,
            arguments: part.functionCall.args || {}
          }
        })
        appendRawPart(rawParts, part)
        continue
      }

      if (typeof part.text === 'string') {
        if (part.thought) {
          if (part.text) {
            fullThinking += part.text
            res.write(`data: ${JSON.stringify({ think: part.text })}\n\n`)
          }
        } else if (part.text) {
          fullContent += part.text
          res.write(`data: ${JSON.stringify({ token: part.text })}\n\n`)
        }

        appendRawPart(rawParts, part)
        continue
      }

      if (part.thoughtSignature) appendRawPart(rawParts, part)
    }

    if (candidate.finishReason) {
      finishReason = candidate.finishReason
      streamCompleted = true
    }
  }

  try {
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true })

      const lines = buffer.split('\n')

      buffer = lines.pop()

      for (const line of lines) {
        const trimmed = line.trim()

        if (!trimmed.startsWith('data:')) continue

        let event

        try {
          event = JSON.parse(trimmed.slice(5).trim())
        } catch {
          continue
        }

        handleEvent(event)
      }
    }

    buffer += decoder.decode()

    const rest = buffer.trim()

    if (rest.startsWith('data:')) {
      try { handleEvent(JSON.parse(rest.slice(5).trim())) } catch (error) {
        if (error?.retryable !== undefined) throw error
      }
    }
  } catch (error) {
    throw streamFailure(error, fullContent || fullThinking)
  }

  if (BLOCKED_FINISH.has(finishReason) && !fullContent && toolCalls.length === 0) {
    throw markProviderError(
      new Error(`Gemini hat die Antwort blockiert (${finishReason}).`),
      { retryable: false }
    )
  }

  if (GLITCH_FINISH.has(finishReason) && toolCalls.length === 0) {
    throw markProviderError(
      new Error(`Gemini: fehlerhafter Werkzeugaufruf (${finishReason}).`),
      { retryable: true, partialOutput: Boolean(fullContent || fullThinking) }
    )
  }

  const prompt =
    (Number(usage?.promptTokenCount) || 0) +
    (Number(usage?.toolUsePromptTokenCount) || 0)
  const completion =
    (Number(usage?.candidatesTokenCount) || 0) +
    (Number(usage?.thoughtsTokenCount) || 0)
  const cached = Number(usage?.cachedContentTokenCount) || 0

  const tokenUsage = {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: prompt + completion,
    cachedTokens: cached,
    cacheWriteTokens: 0,
    cacheObserved: usage?.cachedContentTokenCount !== undefined
  }

  return {
    fullContent,
    fullThinking,
    toolCalls,
    tokenUsage,
    // Nur bei Funktionsaufrufen noetig: Die rohen Teile (mit Denk-Signaturen)
    // gehen in der naechsten Runde unveraendert zurueck.
    rawOutput: toolCalls.length
      ? { provider: RAW_MARKER, parts: rawParts }
      : null,
    completed: streamCompleted
  }
}
// ===================== Ende Gemini Provider =====================
