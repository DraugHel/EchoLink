import test from 'node:test'
import assert from 'node:assert/strict'
import { makeHistoryDb } from './chatHistoryTestDb.mjs'
import {
  CHAT_HISTORY_TOOLS,
  createChatHistoryRequestState,
  executeChatHistoryTool
} from '../server/lib/chatHistoryTools.js'
import {
  resolveStoredChatHistorySources,
  selectCitedChatHistorySources,
  serializeChatHistorySources
} from '../server/lib/chatHistoryEvidence.js'

async function withDb(fn) {
  const db = makeHistoryDb()
  try { return await fn(db) } finally { db.close() }
}

test('search -> read produces bounded source labels and only cited labels persist', async () => withDb(async db => {
  const state = createChatHistoryRequestState({ maxChars: 24000 })
  const search = await executeChatHistoryTool('search_chat_history', { query: 'Mono Stereo' }, {
    db, userId: 1, excludedMessageId: 999, state
  })
  assert.match(search, /messageId/)
  const read = await executeChatHistoryTool('read_chat_excerpt', {
    conversation_id: 10,
    message_id: 105,
    before: 2,
    after: 0
  }, { db, userId: 1, state })
  assert.match(read, /\[H\d+\]/)
  const labels = [...state.catalog.keys()]
  assert.ok(labels.length >= 1)
  const cited = selectCitedChatHistorySources(`Lösung laut [${labels.at(-1)}]. [H9999] ist erfunden.`, state.catalog)
  assert.equal(cited.length, 1)
  assert.equal(cited[0].label, labels.at(-1))
}))

test('identical tool calls are request-local deduplicated and source changes invalidate cache', async () => withDb(async db => {
  const state = createChatHistoryRequestState({ maxChars: 24000 })
  const ctx = { db, userId: 1, state }
  const first = await executeChatHistoryTool('search_chat_history', { query: 'Scarlett' }, ctx)
  const usedAfterFirst = state.usedChars
  const callsAfterFirst = state.searchCalls
  const second = await executeChatHistoryTool('search_chat_history', { query: 'Scarlett' }, ctx)
  assert.equal(second, first)
  assert.equal(state.usedChars, usedAfterFirst)
  assert.equal(state.searchCalls, callsAfterFirst)

  db.prepare('UPDATE messages SET content = ? WHERE id = ?').run('Scarlett geändert.', 101)
  await executeChatHistoryTool('search_chat_history', { query: 'Scarlett' }, ctx)
  assert.equal(state.searchCalls, callsAfterFirst + 1)
}))

test('3+3 limits, abort and total character budget fail closed', async () => withDb(async db => {
  const state = createChatHistoryRequestState({ maxChars: 24000 })
  for (const query of ['Scarlett', 'Guitarix', 'Routing']) {
    await executeChatHistoryTool('search_chat_history', { query }, { db, userId: 1, state })
  }
  await assert.rejects(
    executeChatHistoryTool('search_chat_history', { query: 'Kopfhörer' }, { db, userId: 1, state }),
    error => error.code === 'CHAT_HISTORY_SEARCH_LIMIT'
  )

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    executeChatHistoryTool('read_chat_excerpt', { conversation_id: 10, message_id: 101 }, {
      db, userId: 1, state: createChatHistoryRequestState({ maxChars: 24000 }), signal: controller.signal
    }),
    error => error.name === 'AbortError'
  )

  await assert.rejects(
    executeChatHistoryTool('search_chat_history', { query: 'Scarlett' }, {
      db, userId: 1, state: createChatHistoryRequestState({ maxChars: 20 })
    }),
    error => error.code === 'CHAT_HISTORY_RESULT_LIMIT'
  )
}))

test('reload sources become changed or unavailable without serving stale copied text', async () => withDb(async db => {
  const state = createChatHistoryRequestState({ maxChars: 24000 })
  await executeChatHistoryTool('read_chat_excerpt', {
    conversation_id: 10, message_id: 105, before: 0, after: 0
  }, { db, userId: 1, state })
  const label = [...state.catalog.keys()][0]
  const raw = serializeChatHistorySources(
    selectCitedChatHistorySources(`Quelle [${label}]`, state.catalog)
  )
  assert.equal(resolveStoredChatHistorySources(db, 1, raw)[0].status, 'available')
  db.prepare('UPDATE messages SET content = ? WHERE id = 105').run('Geänderter Inhalt')
  const changed = resolveStoredChatHistorySources(db, 1, raw)[0]
  assert.equal(changed.status, 'changed')
  assert.equal(Object.hasOwn(changed, 'content'), false)
  db.prepare('DELETE FROM messages WHERE id = 105').run()
  assert.equal(resolveStoredChatHistorySources(db, 1, raw)[0].status, 'unavailable')
}))


test('runtime budget ignores model pauses before and between history tool calls', async () => withDb(async db => {
  const state = createChatHistoryRequestState({
    maxChars: 24000,
    env: { CHAT_HISTORY_RETRIEVAL_BUDGET_MS: '250' }
  })

  await new Promise(resolve => setTimeout(resolve, 300))
  const search = await executeChatHistoryTool('search_chat_history', { query: 'Scarlett' }, {
    db, userId: 1, state
  })
  assert.match(search, /Scarlett/)

  await new Promise(resolve => setTimeout(resolve, 300))
  const read = await executeChatHistoryTool('read_chat_excerpt', {
    conversation_id: 10,
    message_id: 101,
    before: 0,
    after: 0
  }, { db, userId: 1, state })

  assert.match(read, /\[H\d+\]/)
  assert.ok(state.runtimeUsedMs < state.runtimeBudgetMs)
}))

test('runtime budget still rejects history work that itself exceeds the cap', async () => withDb(async db => {
  const state = createChatHistoryRequestState({
    maxChars: 24000,
    env: { CHAT_HISTORY_RETRIEVAL_BUDGET_MS: '250' }
  })
  const waitArray = new Int32Array(new SharedArrayBuffer(4))
  const slowDb = new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') {
        return (...args) => {
          Atomics.wait(waitArray, 0, 0, 275)
          return target.prepare(...args)
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })

  await assert.rejects(
    executeChatHistoryTool('search_chat_history', { query: 'Scarlett' }, {
      db: slowDb, userId: 1, state
    }),
    error => error.code === 'CHAT_HISTORY_RUNTIME_LIMIT'
  )
  assert.ok(state.runtimeUsedMs >= state.runtimeBudgetMs)
}))

test('search tool does not expose a conversation_id for the model to guess', () => {
  const searchTool = CHAT_HISTORY_TOOLS.find(tool => tool.function.name === 'search_chat_history')
  assert.ok(searchTool)
  assert.equal(
    Object.hasOwn(searchTool.function.parameters.properties, 'conversation_id'),
    false
  )
  assert.match(searchTool.function.description, /Do not guess or invent conversation IDs/)
})

test('guessed search conversation IDs fail without consuming the three-search quota', async () => withDb(async db => {
  const state = createChatHistoryRequestState({ maxChars: 24000 })

  for (const conversationId of [999, 998, 997]) {
    await assert.rejects(
      executeChatHistoryTool('search_chat_history', {
        query: 'Scarlett',
        conversation_id: conversationId
      }, { db, userId: 1, state }),
      error => error.code === 'CHAT_HISTORY_UNTRUSTED_CONVERSATION_ID'
    )
  }

  assert.equal(state.searchCalls, 0)

  for (const query of ['Scarlett', 'Guitarix', 'Routing']) {
    await executeChatHistoryTool('search_chat_history', { query }, { db, userId: 1, state })
  }
  assert.equal(state.searchCalls, 3)
  await assert.rejects(
    executeChatHistoryTool('search_chat_history', { query: 'Kopfhörer' }, { db, userId: 1, state }),
    error => error.code === 'CHAT_HISTORY_SEARCH_LIMIT'
  )
}))

test('failed excerpt lookups do not consume the three-read quota', async () => withDb(async db => {
  const state = createChatHistoryRequestState({ maxChars: 24000 })
  await assert.rejects(
    executeChatHistoryTool('read_chat_excerpt', {
      conversation_id: 10,
      message_id: 999,
      before: 0,
      after: 0
    }, { db, userId: 1, state }),
    error => error.code === 'CHAT_HISTORY_NOT_FOUND'
  )
  assert.equal(state.readCalls, 0)
}))
