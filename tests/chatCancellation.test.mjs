import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  activeChatRequestCount,
  attachChatResponse,
  assertChatRequestActive,
  cancelChatRequest,
  completeChatRequest,
  createChatResponseSink,
  findChatRequest,
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

test('mobiler Stream darf sich lösen und wieder anhängen ohne Luna abzubrechen', () => {
  const controller = new AbortController()
  const entry = registerChatRequest({
    userId: 9,
    conversationId: 13,
    requestId: 'mobile-background-request',
    controller,
    payloadHash: 'payload-one'
  })
  const first = {
    chunks: [],
    writableEnded: false,
    destroyed: false,
    write(chunk) {
      this.chunks.push(chunk)
      return true
    },
    end() {
      this.writableEnded = true
    }
  }
  const detachFirst = attachChatResponse(entry, first)
  const stream = createChatResponseSink(entry)

  stream.write('first')
  detachFirst()
  stream.write('while-backgrounded')

  assert.equal(controller.signal.aborted, false)
  assert.deepEqual(first.chunks, ['first'])

  const second = {
    chunks: [],
    writableEnded: false,
    destroyed: false,
    write(chunk) {
      this.chunks.push(chunk)
      return true
    },
    end() {
      this.writableEnded = true
    }
  }
  attachChatResponse(entry, second)
  stream.write('after-reconnect')

  assert.deepEqual(second.chunks, ['after-reconnect'])
  assert.equal(completeChatRequest(entry), true)
  assert.equal(second.writableEnded, true)
  assert.equal(activeChatRequestCount(), 0)
  assert.deepEqual(
    findChatRequest({
      userId: 9,
      conversationId: 13,
      requestId: 'mobile-background-request'
    }),
    {
      state: 'completed',
      payloadHash: 'payload-one',
      entry: null
    }
  )
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
  assert.match(
    chatRoute,
    /const onDisconnect = \(\) => \{[\s\S]*detachResponse\(\)[\s\S]*detachPendingE3ActionsForRequest/
  )
  assert.doesNotMatch(
    chatRoute,
    /const onDisconnect = \(\) => \{[\s\S]{0,600}abortChatRequest\(activeRequest\)/
  )
  assert.match(
    chatRoute,
    /if \(!isChatRequestCancelled\(activeRequest\)\) \{[\s\S]*INSERT INTO messages/
  )
})
