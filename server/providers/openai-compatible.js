import { ALL_TOOLS } from '../lib/toolRegistry.js'

function imgMediaType(b64) {
  if (b64.startsWith('/9j/')) return 'image/jpeg'
  if (b64.startsWith('iVBOR')) return 'image/png'
  if (b64.startsWith('R0lGOD')) return 'image/gif'
  if (b64.startsWith('UklGR')) return 'image/webp'
  return 'image/jpeg'
}

// ===================== Z.ai (Zhipu) Provider — OpenAI-kompatibel =====================
const ZAI_URL = 'https://api.z.ai/api/paas/v4/chat/completions'
export const ZAI_KEY = process.env.ZAI_API_KEY || ''

// Ollama-internes Format -> OpenAI Chat Completions Format
function toOpenAI(messages) {
  const out = []
  let pendingIds = []
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      pendingIds = []
      out.push({
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.tool_calls.map((tc, i) => {
          const id = tc.id || `call_gen_${out.length}_${i}`
          pendingIds.push(id)
          return {
            id, type: 'function',
            function: { name: tc.function.name, arguments: JSON.stringify(tc.function.arguments || {}) }
          }
        })
      })
      continue
    }
    if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: pendingIds.shift() || `call_gen_${out.length}`, content: String(m.content ?? '') })
      continue
    }
    if (m.images?.length) {
      const parts = m.images.map(b64 => ({
        type: 'image_url', image_url: { url: `data:${imgMediaType(b64)};base64,${b64}` }
      }))
      if (m.content) parts.push({ type: 'text', text: m.content })
      out.push({ role: m.role, content: parts })
    } else {
      out.push({ role: m.role, content: m.content || '' })
    }
  }
  return out
}

// Split the dynamic timeNote out of the first system message so the stable
// system prefix can be prompt-cached by OpenAI. The timeNote is re-inserted
// as a separate system message right before the last user message.
export function splitSystemTimeNote(messages) {
  const out = messages.map(m => ({ ...m }))
  const sysIdx = out.findIndex(m => m.role === 'system')
  if (sysIdx === -1) return out
  const content = out[sysIdx].content || ''
  const marker = 'Current date and time:'
  const idx = content.indexOf(marker)
  if (idx === -1) return out
  const stable = content.slice(0, idx).trim()
  const timeNote = content.slice(idx).trim()
  if (!stable && !timeNote) return out
  out[sysIdx].content = stable
  const lastUserIdx = out.map((m, i) => ({ m, i })).filter(({ m }) => m.role === 'user').pop()?.i
  if (lastUserIdx !== undefined) {
    out.splice(lastUserIdx, 0, { role: 'system', content: timeNote })
  } else {
    out.push({ role: 'system', content: timeNote })
  }
  return out
}

// Gleiches Interface wie streamOllama: { fullContent, fullThinking, toolCalls, tokenUsage }
async function streamOpenAICompatible(providerName, endpoint, key, model, messages, options, res, abortSignal, extra = {}) {
  if (!key) throw new Error(`API-Key fuer ${providerName} fehlt in der .env`)
  const body = {
    model, stream: true,
    messages: toOpenAI(messages),
    tools: options?.tools ?? ALL_TOOLS,
    stream_options: { include_usage: true },
    ...(options?.temperature != null ? { temperature: Math.min(options.temperature, 2) } : {}),
    ...(options?.top_p != null ? { top_p: options.top_p } : {}),
    ...extra
  }
  const r = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: abortSignal
  })
  if (!r.ok) {
    const errBody = await r.text()
    throw new Error(`${providerName} ${r.status}: ${errBody.slice(0, 200)}`)
  }

  let fullContent = '', fullThinking = ''
  const toolAcc = {}
  let usage = null
  let buf = ''
  const decoder = new TextDecoder()

  for await (const chunk of r.body) {
    buf += decoder.decode(chunk, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') continue
      let ev
      try { ev = JSON.parse(payload) } catch { continue }
      if (ev.error) throw new Error(ev.error.message || 'Z.ai stream error')
      if (ev.usage) usage = ev.usage
      const delta = ev.choices?.[0]?.delta
      if (!delta) continue
      if (delta.reasoning_content) {
        fullThinking += delta.reasoning_content
        res.write(`data: ${JSON.stringify({ think: delta.reasoning_content })}\n\n`)
      }
      if (delta.content) {
        fullContent += delta.content
        res.write(`data: ${JSON.stringify({ token: delta.content })}\n\n`)
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0
          if (!toolAcc[idx]) toolAcc[idx] = { id: tc.id || null, name: '', args: '' }
          if (tc.id) toolAcc[idx].id = tc.id
          if (tc.function?.name) toolAcc[idx].name += tc.function.name
          if (tc.function?.arguments) toolAcc[idx].args += tc.function.arguments
        }
      }
    }
  }

  const toolCalls = Object.values(toolAcc).filter(t => t.name).map(t => {
    let args = {}
    try { args = t.args ? JSON.parse(t.args) : {} } catch {}
    return { id: t.id, function: { name: t.name, arguments: args } }
  })
  const tokenUsage = usage ? {
    promptTokens: usage.prompt_tokens || 0,
    completionTokens: usage.completion_tokens || 0,
    totalTokens: usage.total_tokens || ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0))
  } : null
  return { fullContent, fullThinking, toolCalls, tokenUsage }
}

export const streamZai = (model, messages, options, res, abortSignal) =>
  streamOpenAICompatible('Z.ai', ZAI_URL, ZAI_KEY, model, messages, options, res, abortSignal,
    options?.reasoningEffort === 'off' ? { thinking: { type: 'disabled' } } : {})

export const OPENAI_KEY = process.env.OPENAI_API_KEY || ''
// ===================== Ende OpenAI-kompatible Provider =====================
