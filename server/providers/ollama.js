import {
  SEARCH_TOOL,
  FIRECRAWL_TOOL,
  TERMINAL_TOOL
} from '../lib/webSearch.js'

export const OLLAMA_URL =
  process.env.OLLAMA_URL || 'http://localhost:11434'

// Stream from Ollama, collecting tokens and forwarding to client
// abortSignal: AbortController signal to cancel the upstream Ollama fetch on client disconnect
export async function streamOllama(model, messages, options, res, abortSignal) {
  const r = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, messages, stream: true,
      tools: [SEARCH_TOOL, FIRECRAWL_TOOL, TERMINAL_TOOL],
      ...(options?.reasoningEffort === 'off' ? { think: false } : {}),
      options: { temperature: options?.temperature, top_k: options?.top_k, top_p: options?.top_p }
    }),
    signal: abortSignal
  })
  if (!r.ok) {
    const errBody = await r.text()
    throw new Error(`Ollama ${r.status}: ${errBody.slice(0,200)}`)
  }

  let fullContent = ''
  let fullThinking = ''
  let toolCalls = null
  let tokenUsage = null

  const reader = r.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const lines = buffer.split('\n')
    buffer = lines.pop() // keep incomplete line

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const data = JSON.parse(line)

        // Check for Ollama error in stream
        if (data.error) throw new Error(data.error)

        if (data.done) {
          // Final event — may contain tool calls and token usage
          if (data.message?.tool_calls && data.message.tool_calls.length > 0) {
            toolCalls = data.message.tool_calls
          }
          // Extract token usage from Ollama
          if (data.total_duration) {
            tokenUsage = {
              promptTokens: data.prompt_eval_count || 0,
              completionTokens: data.eval_count || 0,
              totalTokens: (data.prompt_eval_count || 0) + (data.eval_count || 0)
            }
          }
          continue
        }

        if (data.message?.tool_calls) {
          toolCalls = data.message.tool_calls
        }

        if (data.message?.content) {
          fullContent += data.message.content
          res.write(`data: ${JSON.stringify({ token: data.message.content })}\n\n`)
        }

        if (data.message?.thinking) {
          fullThinking += data.message.thinking
          res.write(`data: ${JSON.stringify({ think: data.message.thinking })}\n\n`)
        }

      } catch (e) {
        // Re-throw real errors (including data.error), but don't crash on JSON parse noise
        if (e.message && !e.message.includes('JSON')) throw e
      }
    }
  }

  return { fullContent, fullThinking, toolCalls, tokenUsage }
}
