import { ALL_TOOLS } from '../lib/toolRegistry.js'
import { imgMediaType } from '../lib/images.js'

// ===================== Anthropic API Provider =====================
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
export const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || ''

function anthropicTools(tools = ALL_TOOLS) {
  return tools.map(t => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters
  }))
}

// Ollama-internes Message-Format -> Anthropic Messages API Format
function toAnthropic(messages) {
  let system = ''
  const out = []
  let pendingToolIds = []
  for (const m of messages) {
    if (m.role === 'system') { system += (system ? '\n\n' : '') + m.content; continue }
    if (m.role === 'assistant' && m._raw) {
      pendingToolIds = m._raw.filter(b => b.type === 'tool_use').map(b => b.id)
      // Invariante: _raw ist read-only geteilter Zustand (Signaturen muessen byte-identisch
      // ueber alle Iterationen bleiben). Kopie an der Grenze — Mutationen wie cache_control
      // treffen dann nur die Kopie dieses Requests, nie die naechste Iteration.
      out.push({ role: 'assistant', content: m._raw.map(b => ({ ...b })) })
      continue
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const blocks = []
      if (m.content) blocks.push({ type: 'text', text: m.content })
      pendingToolIds = []
      m.tool_calls.forEach((tc, i) => {
        const id = tc.id || `toolu_gen_${out.length}_${i}`
        pendingToolIds.push(id)
        blocks.push({ type: 'tool_use', id, name: tc.function.name, input: tc.function.arguments || {} })
      })
      out.push({ role: 'assistant', content: blocks })
      continue
    }
    if (m.role === 'tool') {
      let id = m.tool_call_id

      if (id) {
        // Passende ID entfernen, damit spätere Legacy-Nachrichten weiterhin
        // den korrekten verbliebenen Tool-Call erhalten.
        const pendingIndex = pendingToolIds.indexOf(id)
        if (pendingIndex !== -1) pendingToolIds.splice(pendingIndex, 1)
      } else {
        // Rückwärtskompatibilität für alte Chats ohne gespeicherte Call-ID.
        id = pendingToolIds.shift() || `toolu_gen_${out.length}`
      }

      const block = {
        type: 'tool_result',
        tool_use_id: id,
        content: String(m.content ?? '')
      }
      const last = out[out.length - 1]
      if (last && last.role === 'user' && Array.isArray(last.content) && last.content[0]?.type === 'tool_result') {
        last.content.push(block)
      } else {
        out.push({ role: 'user', content: [block] })
      }
      continue
    }
    if (m.images?.length) {
      const blocks = m.images.map(b64 => ({
        type: 'image', source: { type: 'base64', media_type: imgMediaType(b64), data: b64 }
      }))
      if (m.content) blocks.push({ type: 'text', text: m.content })
      out.push({ role: m.role, content: blocks })
    } else {
      out.push({ role: m.role, content: m.content || '' })
    }
  }
  return { system, messages: out }
}

// Gleiches Interface wie streamOllama: { fullContent, fullThinking, toolCalls, tokenUsage }
export async function streamAnthropic(model, messages, options, res, abortSignal) {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY fehlt in der .env')
  const { system, messages: msgs } = toAnthropic(messages)

  // --- Prompt Caching ---
  // Alte Cache-Marker abraeumen: _raw-Bloecke werden per Referenz wiederverwendet,
  // sonst akkumulieren Breakpoints ueber die Tool-Iterationen (API-Limit: 4)
  for (const m of msgs) {
    if (Array.isArray(m.content)) {
      for (const b of m.content) { if (b && b.cache_control) delete b.cache_control }
    }
  }
  // Die timeNote (aendert sich minuetlich) wuerde den Cache-Praefix jedes Mal
  // invalidieren -> raus aus dem System-Prompt, rein in die letzte User-Message
  // (die ist ohnehin nie Teil eines Cache-Hits).
  let stableSystem = system
  let timeNote = ''
  {
    const lines = stableSystem.split('\n')
    const kept = []
    for (const ln of lines) {
      if (ln.startsWith('Current date and time:')) timeNote = ln
      else kept.push(ln)
    }
    stableSystem = kept.join('\n').trim()
  }
  if (timeNote) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') {
        if (typeof msgs[i].content === 'string') {
          msgs[i].content += `\n\n[${timeNote}]`
        } else if (Array.isArray(msgs[i].content)) {
          msgs[i].content.push({ type: 'text', text: `[${timeNote}]` })
        }
        break
      }
    }
  }
  // Breakpoint 1: stabiler System-Prompt (cached auch die Tools davor mit)
  const systemParam = stableSystem
    ? [{ type: 'text', text: stableSystem, cache_control: { type: 'ephemeral' } }]
    : undefined
  // Breakpoint 2: vorletzte Message -> History-Praefix waechst inkrementell mit
  if (msgs.length >= 2) {
    const m = msgs[msgs.length - 2]
    if (typeof m.content === 'string' && m.content) {
      m.content = [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }]
    } else if (Array.isArray(m.content) && m.content.length) {
      // Breakpoint nie auf Thinking-Bloecke setzen
      for (let j = m.content.length - 1; j >= 0; j--) {
        if (m.content[j].type !== 'thinking' && m.content[j].type !== 'redacted_thinking') {
          m.content[j].cache_control = { type: 'ephemeral' }
          break
        }
      }
    }
  }
  // --- Ende Prompt Caching ---

  const RE = options?.reasoningEffort || ''
  const thinkingOn = RE !== '' && RE !== 'off'
  const body = {
    model, max_tokens: 16384, stream: true,
    messages: msgs,
    tools: anthropicTools(options?.tools ?? ALL_TOOLS),
    ...(systemParam ? { system: systemParam } : {}),
    // Thinking an: adaptive + effort; temperature ist dann nicht erlaubt
    ...(thinkingOn
      ? { thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: RE } }
      : (options?.temperature != null ? { temperature: Math.min(options.temperature, 1) } : {}))
  }
  const r = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body),
    signal: abortSignal
  })
  if (!r.ok) {
    const errBody = await r.text()
    throw new Error(`Anthropic ${r.status}: ${errBody.slice(0, 200)}`)
  }

  let fullContent = '', fullThinking = ''
  const toolBlocks = {}
  const rawBlocks = {}  // alle Content-Bloecke in Reihenfolge — muessen bei Tool-Use verbatim zurueck
  let inputTokens = 0, outputTokens = 0
  let buf = ''
  const decoder = new TextDecoder()

  for await (const chunk of r.body) {
    buf += decoder.decode(chunk, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      let ev
      try { ev = JSON.parse(line.slice(6)) } catch { continue }
      if (ev.type === 'error') throw new Error(ev.error?.message || 'Anthropic stream error')
      if (ev.type === 'message_start') {
        const u = ev.message?.usage || {}
        // Cache-Tokens mitzaehlen, damit die Anzeige die echte Kontextgroesse zeigt
        inputTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
      }
      if (ev.type === 'content_block_start' && ev.content_block) {
        const cb = ev.content_block
        if (cb.type === 'tool_use') {
          toolBlocks[ev.index] = { id: cb.id, name: cb.name, json: '' }
          rawBlocks[ev.index] = { type: 'tool_use', id: cb.id, name: cb.name, input: {} }
        } else if (cb.type === 'thinking') {
          rawBlocks[ev.index] = { type: 'thinking', thinking: '', signature: '' }
        } else if (cb.type === 'redacted_thinking') {
          rawBlocks[ev.index] = { type: 'redacted_thinking', data: cb.data }
        } else if (cb.type === 'text') {
          rawBlocks[ev.index] = { type: 'text', text: '' }
        }
      }
      if (ev.type === 'content_block_delta') {
        if (ev.delta?.type === 'text_delta') {
          fullContent += ev.delta.text
          if (rawBlocks[ev.index]) rawBlocks[ev.index].text += ev.delta.text
          res.write(`data: ${JSON.stringify({ token: ev.delta.text })}\n\n`)
        } else if (ev.delta?.type === 'thinking_delta' && ev.delta.thinking) {
          fullThinking += ev.delta.thinking
          if (rawBlocks[ev.index]) rawBlocks[ev.index].thinking += ev.delta.thinking
          res.write(`data: ${JSON.stringify({ think: ev.delta.thinking })}\n\n`)
        } else if (ev.delta?.type === 'signature_delta' && rawBlocks[ev.index]) {
          rawBlocks[ev.index].signature = (rawBlocks[ev.index].signature || '') + ev.delta.signature
        } else if (ev.delta?.type === 'input_json_delta' && toolBlocks[ev.index]) {
          toolBlocks[ev.index].json += ev.delta.partial_json
        }
      }
      if (ev.type === 'message_delta' && ev.usage?.output_tokens != null) {
        outputTokens = ev.usage.output_tokens
      }
    }
  }

  const toolCalls = Object.values(toolBlocks).map(t => {
    let args = {}
    try { args = t.json ? JSON.parse(t.json) : {} } catch {}
    return { id: t.id, function: { name: t.name, arguments: args } }
  })
  // tool_use-Inputs in den rohen Bloecken finalisieren
  for (const [idx, tb] of Object.entries(toolBlocks)) {
    if (rawBlocks[idx]) {
      try { rawBlocks[idx].input = tb.json ? JSON.parse(tb.json) : {} } catch {}
    }
  }
  const rawOutput = Object.keys(rawBlocks).length
    ? Object.keys(rawBlocks).sort((a, b) => a - b).map(k => rawBlocks[k])
    : null
  const tokenUsage = {
    promptTokens: inputTokens,
    completionTokens: outputTokens,
    totalTokens: inputTokens + outputTokens
  }
  return { fullContent, fullThinking, toolCalls, tokenUsage, rawOutput }
}
// ===================== Ende Anthropic Provider =====================
