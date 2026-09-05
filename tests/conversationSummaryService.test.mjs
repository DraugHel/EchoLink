import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'echolink-summary-test-'))
process.env.ECHOLINK_DB_PATH = path.join(tempRoot, 'echolink.db')
process.env.DEFAULT_MODEL = 'plain-model'

const { default: db } = await import('../server/db.js')
const {
  createConversationSummaryService
} = await import('../server/lib/conversationSummaryService.js')

after(() => {
  try { db.close() } catch {}
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

function createUser(name) {
  return Number(db.prepare(`
    INSERT INTO users (username, password_hash)
    VALUES (?, 'test')
  `).run(name).lastInsertRowid)
}

function createConversation(userId, {
  title = 'Source',
  model = 'plain-model',
  systemPrompt = 'system',
  temperature = 0.25,
  topK = 31,
  topP = 0.77,
  reasoningEffort = 'high',
  messages = ['hello', 'world']
} = {}) {
  const id = Number(db.prepare(`
    INSERT INTO conversations (
      user_id, title, model, system_prompt,
      temperature, top_k, top_p, reasoning_effort
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    title,
    model,
    systemPrompt,
    temperature,
    topK,
    topP,
    reasoningEffort
  ).lastInsertRowid)

  const insertMessage = db.prepare(`
    INSERT INTO messages (conversation_id, role, content)
    VALUES (?, ?, ?)
  `)
  messages.forEach((content, index) => {
    insertMessage.run(id, index % 2 ? 'assistant' : 'user', content)
  })
  return id
}

function summaryText(conversationId) {
  const first = db.prepare(`
    SELECT id FROM messages
    WHERE conversation_id = ?
    ORDER BY id ASC LIMIT 1
  `).get(conversationId)
  return `## Ziel und Thema\nTest [Nachricht ${first.id}]\n\n## Aktueller Stand\nOK\n\n## Entscheidungen und wichtige Vorgaben\n–\n\n## Bisherige Versuche und Ergebnisse\n–\n\n## Offene Fragen und nächster Schritt\nWeiter\n\n## Relevante Dateien, Befehle und Quellen\n–`
}

function completedProvider(counter, conversationId, overrides = {}) {
  return async request => {
    counter.calls += 1
    counter.requests.push(request)
    return {
      completed: true,
      fullContent: summaryText(conversationId),
      fullThinking: 'not persisted',
      toolCalls: [],
      tokenUsage: {
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        cachedTokens: 0,
        cacheWriteTokens: 0
      },
      provider: 'test',
      ...overrides
    }
  }
}

const owner = createUser('owner')
const other = createUser('other')

test('ownership is checked before any provider call', async () => {
  const sourceId = createConversation(owner)
  const counter = { calls: 0, requests: [] }
  const service = createConversationSummaryService({
    db,
    runProvider: completedProvider(counter, sourceId)
  })

  await assert.rejects(
    service.generate(other, sourceId, {
      model: 'plain-model',
      requestId: 'summary:foreign-001'
    }),
    error => error.status === 404
  )
  assert.equal(counter.calls, 0)
  assert.throws(
    () => service.cancel(other, sourceId, 'summary:foreign-001'),
    error => error.status === 404
  )
})

test('empty chats and active chat runs are rejected without provider calls', async () => {
  const emptyId = createConversation(owner, { messages: [] })
  const activeId = createConversation(owner)
  const counter = { calls: 0, requests: [] }
  const service = createConversationSummaryService({
    db,
    runProvider: completedProvider(counter, activeId),
    hasActiveChatRun: (_userId, conversationId) => conversationId === activeId
  })

  await assert.rejects(
    service.generate(owner, emptyId, { model: 'plain-model', requestId: 'summary:empty-001' }),
    error => error.code === 'SUMMARY_EMPTY_SOURCE'
  )
  await assert.rejects(
    service.generate(owner, activeId, { model: 'plain-model', requestId: 'summary:active-001' }),
    error => error.code === 'SUMMARY_SOURCE_ACTIVE'
  )
  assert.equal(counter.calls, 0)
})

test('short generation is tool-free, persisted and usage is recorded once', async () => {
  const sourceId = createConversation(owner)
  const counter = { calls: 0, requests: [] }
  const service = createConversationSummaryService({
    db,
    runProvider: completedProvider(counter, sourceId)
  })

  const result = await service.generate(owner, sourceId, {
    model: 'plain-model',
    requestId: 'summary:short-001'
  })
  assert.equal(counter.calls, 1)
  assert.deepEqual(counter.requests[0].tools, [])
  assert.equal(result.summary.revision, 1)
  assert.match(result.summary.content, /Ziel und Thema/)
  assert.equal(result.cost.calls, 1)

  const usageCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM model_usage_events
    WHERE user_id = ?
      AND conversation_id = ?
      AND purpose = 'conversation_summary'
  `).get(owner, sourceId).count
  assert.equal(usageCount, 1)
})

test('cancel aborts the matching request and cleans the registry', async () => {
  const sourceId = createConversation(owner)
  let started
  const startedPromise = new Promise(resolve => { started = resolve })
  const service = createConversationSummaryService({
    db,
    runProvider: ({ signal }) => new Promise((resolve, reject) => {
      started()
      signal.addEventListener('abort', () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      }, { once: true })
    })
  })

  const pending = service.generate(owner, sourceId, {
    model: 'plain-model',
    requestId: 'summary:cancel-001'
  })
  await startedPromise
  assert.deepEqual(
    service.cancel(owner, sourceId, 'summary:cancel-001'),
    { cancelled: true }
  )
  await assert.rejects(pending, error => error.code === 'SUMMARY_CANCELLED')
  assert.equal(service.activeGenerationCount(), 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM conversation_summaries WHERE source_conversation_id = ?').get(sourceId).count, 0)
})

test('source edits during generation cause a hash conflict and preserve the old draft', async () => {
  const sourceId = createConversation(owner)
  const firstService = createConversationSummaryService({
    db,
    runProvider: completedProvider({ calls: 0, requests: [] }, sourceId)
  })
  const initial = await firstService.generate(owner, sourceId, {
    model: 'plain-model',
    requestId: 'summary:hash-initial'
  })

  let release
  let started
  const gate = new Promise(resolve => { release = resolve })
  const startedPromise = new Promise(resolve => { started = resolve })
  const service = createConversationSummaryService({
    db,
    runProvider: async () => {
      started()
      await gate
      return {
        completed: true,
        fullContent: summaryText(sourceId),
        toolCalls: [],
        tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        provider: 'test'
      }
    }
  })

  const pending = service.generate(owner, sourceId, {
    model: 'plain-model',
    requestId: 'summary:hash-change'
  })
  await startedPromise
  const firstMessage = db.prepare('SELECT id FROM messages WHERE conversation_id = ? ORDER BY id LIMIT 1').get(sourceId)
  db.prepare('UPDATE messages SET content = ? WHERE id = ?').run('edited while generating', firstMessage.id)
  release()

  await assert.rejects(pending, error => error.code === 'SUMMARY_SOURCE_CHANGED')
  const stored = service.getState(owner, sourceId).summary
  assert.equal(stored.revision, initial.summary.revision)
  assert.equal(stored.content, initial.summary.content)
})

test('revision protects edits from lost updates', async () => {
  const sourceId = createConversation(owner)
  const service = createConversationSummaryService({
    db,
    runProvider: completedProvider({ calls: 0, requests: [] }, sourceId)
  })
  const generated = await service.generate(owner, sourceId, {
    model: 'plain-model',
    requestId: 'summary:revision-gen'
  })

  const saved = service.save(owner, sourceId, {
    content: `${generated.summary.content}\nmanual edit`,
    expectedRevision: generated.summary.revision
  })
  assert.equal(saved.summary.revision, generated.summary.revision + 1)

  assert.throws(
    () => service.save(owner, sourceId, {
      content: 'stale tab',
      expectedRevision: generated.summary.revision
    }),
    error => error.code === 'SUMMARY_REVISION_CONFLICT'
  )
})

test('continue is atomic, idempotent, inherits settings and performs no model or memory call', async () => {
  const sourceId = createConversation(owner, {
    title: 'Very long source title '.repeat(10),
    model: 'openai/gpt-test',
    systemPrompt: 'keep this',
    temperature: 0.33,
    topK: 17,
    topP: 0.66,
    reasoningEffort: 'max'
  })
  const counter = { calls: 0, requests: [] }
  const service = createConversationSummaryService({
    db,
    runProvider: completedProvider(counter, sourceId)
  })
  const generated = await service.generate(owner, sourceId, {
    model: 'plain-model',
    requestId: 'summary:continue-gen'
  })
  const edited = `${generated.summary.content}\n\nManuell ergänzt.`

  const first = service.continueFromSummary(owner, sourceId, {
    content: edited,
    expectedRevision: generated.summary.revision,
    requestId: 'summary:continue-001'
  })
  const retry = service.continueFromSummary(owner, sourceId, {
    content: edited,
    expectedRevision: generated.summary.revision,
    requestId: 'summary:continue-001'
  })

  assert.equal(retry.restored, true)
  assert.equal(retry.conversation.id, first.conversation.id)
  assert.equal(counter.calls, 1, 'continue must not call the model again')

  const target = db.prepare('SELECT * FROM conversations WHERE id = ?').get(first.conversation.id)
  assert.equal(target.model, 'openai/gpt-test')
  assert.equal(target.system_prompt, 'keep this')
  assert.equal(target.temperature, 0.33)
  assert.equal(target.top_k, 17)
  assert.equal(target.top_p, 0.66)
  assert.equal(target.reasoning_effort, 'max')
  assert.ok(target.title.length <= 120)
  assert.match(target.title, /Fortsetzung$/)

  const targetMessages = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id').all(target.id)
  assert.equal(targetMessages.length, 1)
  assert.equal(targetMessages[0].role, 'user')
  assert.match(targetMessages[0].content, /historischer Kontext/)
  assert.match(targetMessages[0].content, /Manuell ergänzt/)

  const targetCount = db.prepare(`
    SELECT COUNT(*) AS count FROM conversations
    WHERE user_id = ? AND title = ?
  `).get(owner, target.title).count
  assert.equal(targetCount, 1)
})

test('continue rolls back completely when a failure occurs after target insert', async () => {
  const sourceId = createConversation(owner)
  const generator = createConversationSummaryService({
    db,
    runProvider: completedProvider({ calls: 0, requests: [] }, sourceId)
  })
  const generated = await generator.generate(owner, sourceId, {
    model: 'plain-model',
    requestId: 'summary:rollback-gen'
  })
  const before = db.prepare('SELECT COUNT(*) AS count FROM conversations').get().count

  const failing = createConversationSummaryService({
    db,
    hooks: {
      afterTargetInsert() {
        throw new Error('forced transaction failure')
      }
    }
  })

  assert.throws(
    () => failing.continueFromSummary(owner, sourceId, {
      content: generated.summary.content,
      expectedRevision: generated.summary.revision,
      requestId: 'summary:rollback-001'
    }),
    /forced transaction failure/
  )
  const afterCount = db.prepare('SELECT COUNT(*) AS count FROM conversations').get().count
  assert.equal(afterCount, before)
  const stored = failing.getState(owner, sourceId).summary
  assert.equal(stored.continuedConversationId, null)
})

test('deleting the source later leaves the continuation chat usable', async () => {
  const sourceId = createConversation(owner)
  const service = createConversationSummaryService({
    db,
    runProvider: completedProvider({ calls: 0, requests: [] }, sourceId)
  })
  const generated = await service.generate(owner, sourceId, {
    model: 'plain-model',
    requestId: 'summary:delete-source-gen'
  })
  const continued = service.continueFromSummary(owner, sourceId, {
    content: generated.summary.content,
    expectedRevision: generated.summary.revision,
    requestId: 'summary:delete-source-continue'
  })

  db.prepare('DELETE FROM conversations WHERE id = ?').run(sourceId)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM conversation_summaries WHERE source_conversation_id = ?').get(sourceId).count, 0)
  const target = db.prepare('SELECT id FROM conversations WHERE id = ?').get(continued.conversation.id)
  assert.equal(target.id, continued.conversation.id)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?').get(target.id).count, 1)
})

test('duplicate generate request IDs share one in-flight provider call', async () => {
  const sourceId = createConversation(owner)
  let release
  let started
  const gate = new Promise(resolve => { release = resolve })
  const startedPromise = new Promise(resolve => { started = resolve })
  const counter = { calls: 0 }
  const service = createConversationSummaryService({
    db,
    runProvider: async () => {
      counter.calls += 1
      started()
      await gate
      return {
        completed: true,
        fullContent: summaryText(sourceId),
        toolCalls: [],
        tokenUsage: { promptTokens: 2, completionTokens: 2, totalTokens: 4 },
        provider: 'test'
      }
    }
  })

  const first = service.generate(owner, sourceId, {
    model: 'plain-model',
    requestId: 'summary:duplicate-001'
  })
  await startedPromise
  const second = service.generate(owner, sourceId, {
    model: 'plain-model',
    requestId: 'summary:duplicate-001'
  })
  assert.equal(counter.calls, 1)
  release()

  const [a, b] = await Promise.all([first, second])
  assert.equal(counter.calls, 1)
  assert.equal(a.summary.id, b.summary.id)
  assert.equal(a.summary.revision, b.summary.revision)
})

test('incomplete output and tool calls never replace a valid existing draft', async () => {
  const sourceId = createConversation(owner)
  const initialService = createConversationSummaryService({
    db,
    runProvider: completedProvider({ calls: 0, requests: [] }, sourceId)
  })
  const initial = await initialService.generate(owner, sourceId, {
    model: 'plain-model',
    requestId: 'summary:invalid-output-initial'
  })

  const incomplete = createConversationSummaryService({
    db,
    runProvider: async () => ({
      completed: false,
      fullContent: 'partial',
      toolCalls: [],
      tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      provider: 'test'
    })
  })
  await assert.rejects(
    incomplete.generate(owner, sourceId, {
      model: 'plain-model',
      requestId: 'summary:incomplete-001'
    }),
    error => error.code === 'SUMMARY_INCOMPLETE_STREAM'
  )
  assert.equal(incomplete.getState(owner, sourceId).summary.revision, initial.summary.revision)
  assert.equal(incomplete.getState(owner, sourceId).summary.content, initial.summary.content)

  const toolCall = createConversationSummaryService({
    db,
    runProvider: async () => ({
      completed: true,
      fullContent: summaryText(sourceId),
      toolCalls: [{ id: 'forbidden', function: { name: 'web_search' } }],
      tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      provider: 'test'
    })
  })
  await assert.rejects(
    toolCall.generate(owner, sourceId, {
      model: 'plain-model',
      requestId: 'summary:toolcall-001'
    }),
    error => error.code === 'SUMMARY_TOOL_CALL'
  )
  assert.equal(toolCall.getState(owner, sourceId).summary.revision, initial.summary.revision)
  assert.equal(toolCall.getState(owner, sourceId).summary.content, initial.summary.content)
})

test('provider timeout leaves no damaged draft and clears the registry', async () => {
  const sourceId = createConversation(owner)
  const service = createConversationSummaryService({
    db,
    env: {
      ...process.env,
      CONVERSATION_SUMMARY_CALL_TIMEOUT_MS: '10',
      CONVERSATION_SUMMARY_TOTAL_TIMEOUT_MS: '2000'
    },
    runProvider: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('aborted by timeout')
        error.name = 'AbortError'
        reject(error)
      }, { once: true })
    })
  })

  await assert.rejects(
    service.generate(owner, sourceId, {
      model: 'plain-model',
      requestId: 'summary:timeout-001'
    }),
    error => error.code === 'SUMMARY_CALL_TIMEOUT'
  )
  assert.equal(service.activeGenerationCount(), 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM conversation_summaries WHERE source_conversation_id = ?').get(sourceId).count, 0)
})

test('long generation covers the whole source through partial calls plus one synthesis', async () => {
  const rows = Array.from({ length: 18 }, (_, index) => `${index}: ${'x'.repeat(2300)}`)
  const sourceId = createConversation(owner, { messages: rows })
  const counter = { calls: 0, requests: [] }
  const service = createConversationSummaryService({
    db,
    env: {
      ...process.env,
      CHAT_CONTEXT_DEFAULT_INPUT_TOKENS: '8000',
      CHAT_CONTEXT_CHARS_PER_TOKEN: '3.2',
      CONVERSATION_SUMMARY_OUTPUT_TOKENS: '2000',
      CONVERSATION_SUMMARY_PART_OUTPUT_TOKENS: '512'
    },
    runProvider: completedProvider(counter, sourceId)
  })

  const result = await service.generate(owner, sourceId, {
    model: 'plain-model',
    requestId: 'summary:long-001'
  })
  assert.equal(result.generationPlan.mode, 'chunked')
  assert.equal(counter.calls, result.generationPlan.calls)
  assert.ok(counter.calls >= 2 && counter.calls <= 9)

  const sourceIds = db.prepare('SELECT id FROM messages WHERE conversation_id = ? ORDER BY id').all(sourceId).map(row => row.id)
  const sourceTextAcrossPartialCalls = counter.requests
    .slice(0, -1)
    .flatMap(request => request.messages || [])
    .map(message => message.content || '')
    .join('\n')
  for (const id of sourceIds) {
    assert.match(sourceTextAcrossPartialCalls, new RegExp(`Nachricht ${id}\\b`))
  }
})

test('an oversized job is rejected before the provider is called', async () => {
  const sourceId = createConversation(owner, {
    messages: Array.from({ length: 40 }, (_, index) => `${index}: ${'x'.repeat(7000)}`)
  })
  const counter = { calls: 0, requests: [] }
  const service = createConversationSummaryService({
    db,
    env: {
      ...process.env,
      CHAT_CONTEXT_DEFAULT_INPUT_TOKENS: '8000',
      CHAT_CONTEXT_CHARS_PER_TOKEN: '3.2',
      CONVERSATION_SUMMARY_OUTPUT_TOKENS: '2000',
      CONVERSATION_SUMMARY_PART_OUTPUT_TOKENS: '512'
    },
    runProvider: completedProvider(counter, sourceId)
  })

  await assert.rejects(
    service.generate(owner, sourceId, {
      model: 'plain-model',
      requestId: 'summary:too-large-001'
    }),
    error => error.code === 'SUMMARY_TOO_LARGE'
  )
  assert.equal(counter.calls, 0)
})

test('reusing a continue request ID with different text is a conflict', async () => {
  const sourceId = createConversation(owner)
  const service = createConversationSummaryService({
    db,
    runProvider: completedProvider({ calls: 0, requests: [] }, sourceId)
  })
  const generated = await service.generate(owner, sourceId, {
    model: 'plain-model',
    requestId: 'summary:continue-conflict-gen'
  })
  service.continueFromSummary(owner, sourceId, {
    content: generated.summary.content,
    expectedRevision: generated.summary.revision,
    requestId: 'summary:continue-conflict-001'
  })

  assert.throws(
    () => service.continueFromSummary(owner, sourceId, {
      content: `${generated.summary.content}\nchanged`,
      expectedRevision: generated.summary.revision,
      requestId: 'summary:continue-conflict-001'
    }),
    error => error.code === 'SUMMARY_CONTINUE_ID_CONFLICT'
  )
})
