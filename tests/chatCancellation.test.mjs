import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  activeChatRequestCount,
  assertChatRequestActive,
  cancelChatRequest,
  registerChatRequest,
  unregisterChatRequest
} from '../server/lib/chatCancellation.js'
import { webSearch } from '../server/lib/webSearch.js'

test('expliziter Chat-Abbruch beendet den registrierten Server-Request', () => {
  const controller = new AbortController()
  const entry = registerChatRequest({
    userId: 7,
    conversationId: 42,
    requestId: 'cancel-test-request',
    controller
  })

  assert.equal(activeChatRequestCount(), 1)
  assert.equal(cancelChatRequest({
    userId: 7,
    conversationId: 41,
    requestId: 'cancel-test-request'
  }), false)
  assert.equal(controller.signal.aborted, false)

  assert.equal(cancelChatRequest({
    userId: 7,
    conversationId: 42,
    requestId: 'cancel-test-request'
  }), true)
  assert.equal(controller.signal.aborted, true)
  assert.throws(
    () => assertChatRequestActive(entry),
    error => error?.name === 'AbortError'
  )

  unregisterChatRequest(entry)
  assert.equal(activeChatRequestCount(), 0)
})

test('eine neue Registrierung mit gleicher ID beendet den alten Lauf', () => {
  const firstController = new AbortController()
  const first = registerChatRequest({
    userId: 8,
    conversationId: 12,
    requestId: 'duplicate-request',
    controller: firstController
  })

  const secondController = new AbortController()
  const second = registerChatRequest({
    userId: 8,
    conversationId: 12,
    requestId: 'duplicate-request',
    controller: secondController
  })

  assert.equal(firstController.signal.aborted, true)
  assert.equal(secondController.signal.aborted, false)
  assert.equal(activeChatRequestCount(), 1)

  unregisterChatRequest(first)
  assert.equal(activeChatRequestCount(), 1)
  unregisterChatRequest(second)
  assert.equal(activeChatRequestCount(), 0)
})


test('Websuche übernimmt das externe Abbruchsignal', async () => {
  const originalFetch = globalThis.fetch
  const controller = new AbortController()

  globalThis.fetch = (_url, options = {}) =>
    new Promise((_resolve, reject) => {
      const rejectAbort = () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      }

      if (options.signal?.aborted) {
        rejectAbort()
        return
      }

      options.signal?.addEventListener(
        'abort',
        rejectAbort,
        { once: true }
      )
    })

  try {
    const searchPromise = webSearch(
      'cancel test',
      controller.signal
    )

    controller.abort()

    const result = await searchPromise
    assert.equal(result.error, 'Search timeout')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Composer-Stop sendet die Request-ID an den Server und Server speichert nach Abbruch nichts', async () => {
  const [chatPage, chatRoute] = await Promise.all([
    readFile(
      new URL(
        '../client/src/pages/Chat.jsx',
        import.meta.url
      ),
      'utf8'
    ),
    readFile(
      new URL(
        '../server/routes/chat.js',
        import.meta.url
      ),
      'utf8'
    )
  ])

  assert.match(
    chatPage,
    /\/api\/chat\/\$\{activeRequest\.conversationId\}\/cancel/
  )
  assert.match(chatPage, /keepalive:\s*true/)
  assert.match(chatPage, /requestId\s*\n?\s*\}/)

  assert.match(
    chatRoute,
    /'\/:conversationId\/cancel'/
  )
  assert.match(
    chatRoute,
    /!isChatRequestCancelled\(activeRequest\)/
  )
  assert.match(
    chatRoute,
    /executeTool\([\s\S]*abortController\.signal/
  )
})
