import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

function source(path) {
  return fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
}

test('interactive registry exposes history while scheduled agent keeps its separate fixed catalog', () => {
  const registry = source('server/lib/toolRegistry.js')
  const agent = source('server/lib/agentRunner.js')
  assert.match(registry, /CHAT_HISTORY_TOOLS/)
  assert.doesNotMatch(agent, /CHAT_HISTORY_TOOLS/)
  assert.match(agent, /const AGENT_TOOLS = \[/)
})

test('chat enforces per-request tool allowlist before dispatch and preserves tool_call_id mapping', () => {
  const chat = source('server/routes/chat.js')
  const guard = chat.indexOf('tool_not_allowed_for_request')
  const terminal = chat.indexOf("if (name === 'terminal')")
  assert.ok(guard > 0 && terminal > guard)
  assert.match(chat, /allowedToolNames/)
  assert.match(chat, /options\.tools = offeredTools/)
  assert.match(chat, /tool_call_id: tc\.id/)
})

test('memory inventory, recall-only and normal chat have distinct offered tool policies', () => {
  const chat = source('server/routes/chat.js')
  assert.match(chat, /recallOnly:\s*recallOnlyRequest/)
  assert.match(chat, /tools:\s*recallOnlyRequest\s*\?\s*\[\]/)
  assert.match(chat, /const offeredTools = memoryInventoryRequest[\s\S]{0,220}\? \[\][\s\S]{0,220}historyRecallRequest[\s\S]{0,120}CHAT_HISTORY_TOOLS/)
  assert.match(chat, /options\.tools = offeredTools/)
  assert.match(chat, /if \(content && !recallOnlyRequest\)/)
})

test('summary path remains explicitly tool-free', () => {
  const provider = source('server/lib/conversationSummaryProvider.js')
  assert.match(provider, /tools:\s*\[\]/)
})

test('history sources are persisted additively and frontend uses existing navigation', () => {
  const db = source('server/db.js')
  const conversations = source('server/routes/conversations.js')
  const chat = source('client/src/pages/Chat.jsx')
  assert.match(db, /chat_history_sources/)
  assert.match(conversations, /resolveStoredChatHistorySources/)
  assert.match(chat, /ChatHistorySources/)
  assert.match(chat, /onOpen=\{openSearchResult\}/)
})
