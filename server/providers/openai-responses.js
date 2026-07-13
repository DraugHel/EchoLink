import { OPENAI_KEY } from './openai-compatible.js'
import {
  SEARCH_TOOL,
  FIRECRAWL_TOOL,
  TERMINAL_TOOL
} from '../lib/webSearch.js'
import { imgMediaType } from '../lib/images.js'

// ===================== OpenAI Responses API (Reasoning + Tools) =====================
const RESPONSES_URL = 'https://api.openai.com/v1/responses'

// Diese Modelle akzeptieren keinen reasoning-Parameter.
// Weitere exakte Modell-IDs können kommasepariert per .env ergänzt werden.
const OPENAI_MODELS_WITHOUT_REASONING_CONFIG = new Set([
  'gpt-5-chat-latest',
  ...(process.env.OPENAI_NO_REASONING_MODELS || '')
    .split(',')
    .map(model => model.trim())
    .filter(Boolean)
])

export function supportsReasoningConfig(model) {
  return !OPENAI_MODELS_WITHOUT_REASONING_CONFIG.has(model)
}

// Internes Format -> Responses-API-Input. Assistant-Messages mit _raw
// (Items aus vorheriger Responses-Iteration, inkl. Reasoning) gehen verbatim zurueck —
// nur so bleibt die Denkkette ueber Tool-Calls hinweg erhalten.
function toResponsesInput(messages) {
  let instructions = ''
  const input = []
  let pendingCallIds = []
  for (const m of messages) {
    if (m.role === 'system') { instructions += (instructions ? '\n\n' : '') + m.content; continue }
    if (m.role === 'assistant' && m._raw) {
      pendingCallIds = m._raw.filter(it => it.type === 'function_call').map(it => it.call_id)
      // Invariante: _raw ist read-only — Kopie an der Grenze (siehe toAnthropic)
      input.push(...m._raw.map(it => ({ ...it })))
      continue
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      if (m.content) input.push({ role: 'assistant', content: [{ type: 'output_text', text: m.content }] })
      pendingCallIds = []
      m.tool_calls.forEach((tc, i) => {
        const id = tc.id || `call_gen_${input.length}_${i}`
        pendingCallIds.push(id)
        input.push({ type: 'function_call', call_id: id, name: tc.function.name, arguments: JSON.stringify(tc.function.arguments || {}) })
      })
      continue
    }
    if (m.role === 'tool') {
      let callId = m.tool_call_id

      if (callId) {
        // Auch aus der Warteschlange entfernen, damit gemischte alte/neue
        // Tool-Nachrichten nicht auf dieselbe Call-ID zeigen.
        const pendingIndex = pendingCallIds.indexOf(callId)
        if (pendingIndex !== -1) pendingCallIds.splice(pendingIndex, 1)
      } else {
        // Rückwärtskompatibilität für alte Chats ohne gespeicherte Call-ID.
        callId = pendingCallIds.shift() || `call_gen_${input.length}`
      }

      input.push({
        type: 'function_call_output',
        call_id: callId,
        output: String(m.content ?? '')
      })
      continue
    }
    if (m.images?.length) {
      const parts = m.images.map(b64 => ({ type: 'input_image', image_url: `data:${imgMediaType(b64)};base64,${b64}` }))
      if (m.content) parts.push({ type: 'input_text', text: m.content })
      input.push({ role: 'user', content: parts })
    } else if (m.role === 'assistant') {
      input.push({ role: 'assistant', content: [{ type: 'output_text', text: m.content || '' }] })
    } else {
      input.push({ role: 'user', content: [{ type: 'input_text', text: m.content || '' }] })
    }
  }
  return { instructions, input }
}

export async function streamResponses(model, messages, options, res, abortSignal) {
  if (!OPENAI_KEY) throw new Error('API-Key fuer OpenAI fehlt in der .env')
  const { instructions, input } = toResponsesInput(messages)
  const body = {
    model, stream: true, store: false,
    include: ['reasoning.encrypted_content'],
    input,
    ...(instructions ? { instructions } : {}),
    tools: [SEARCH_TOOL, FIRECRAWL_TOOL, TERMINAL_TOOL].map(t => ({
      type: 'function', name: t.function.name, description: t.function.description, parameters: t.function.parameters
    })),
    // Nur explizit bekannte Instant-Modelle erhalten keinen reasoning-Parameter.
    ...(supportsReasoningConfig(model) ? { reasoning: {
      summary: 'detailed',
      ...(options?.reasoningEffort
        ? { effort: options.reasoningEffort === 'off' ? 'none' : options.reasoningEffort }
        : {})
    } } : {})
    // Reasoning-Modelle lehnen temperature/top_p ab -> bewusst weggelassen
  }
  const r = await fetch(RESPONSES_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify(body),
    signal: abortSignal
  })
  if (!r.ok) {
    const errBody = await r.text()
    throw new Error(`OpenAI Responses ${r.status}: ${errBody.slice(0, 200)}`)
  }

  let fullContent = '', fullThinking = ''
  let rawOutput = null, usage = null
  let buf = ''
  const decoder = new TextDecoder()

  for await (const chunk of r.body) {
    buf += decoder.decode(chunk, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      let ev
      try { ev = JSON.parse(payload) } catch { continue }
      if (ev.type === 'response.output_text.delta' && ev.delta) {
        fullContent += ev.delta
        res.write(`data: ${JSON.stringify({ token: ev.delta })}\n\n`)
      } else if (ev.type === 'response.reasoning_summary_text.delta' && ev.delta) {
        fullThinking += ev.delta
        res.write(`data: ${JSON.stringify({ think: ev.delta })}\n\n`)
      } else if (ev.type === 'response.completed') {
        rawOutput = ev.response?.output || null
        usage = ev.response?.usage || null
      } else if (ev.type === 'response.failed' || ev.type === 'error') {
        throw new Error(ev.response?.error?.message || ev.message || 'OpenAI Responses stream error')
      }
    }
  }

  const toolCalls = (rawOutput || []).filter(it => it.type === 'function_call').map(it => {
    let args = {}
    try { args = it.arguments ? JSON.parse(it.arguments) : {} } catch {}
    return { id: it.call_id, function: { name: it.name, arguments: args } }
  })
  const tokenUsage = usage ? {
    promptTokens: usage.input_tokens || 0,
    completionTokens: usage.output_tokens || 0,
    totalTokens: usage.total_tokens || ((usage.input_tokens || 0) + (usage.output_tokens || 0))
  } : null
  return { fullContent, fullThinking, toolCalls, tokenUsage, rawOutput }
}
// ===================== Ende Responses API =====================
