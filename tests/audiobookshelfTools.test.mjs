import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AUDIOBOOKSHELF_TOOL_NAMES,
  AUDIOBOOKSHELF_WRITE_TOOL_NAMES,
  audiobookshelfToolsEnabled,
  executeAudiobookshelfTool,
  formatAudiobookshelfPreview,
  prepareAudiobookshelfAction
} from '../server/lib/audiobookshelfTools.js'

const env = {
  PORT: '3000',
  ECHO_API_KEY: 'echo-secret',
  AUDIOBOOKSHELF_URL: 'https://abs.example.test/audiobookshelf',
  AUDIOBOOKSHELF_API_KEY: 'abs-secret'
}

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

test('native Audiobookshelf catalog exposes bounded read tools plus one write tool', () => {
  assert.deepEqual(
    [...AUDIOBOOKSHELF_TOOL_NAMES].sort(),
    [
      'audiobookshelf_get_item',
      'audiobookshelf_list_items',
      'audiobookshelf_list_libraries',
      'audiobookshelf_status',
      'audiobookshelf_update_metadata'
    ]
  )
  assert.deepEqual(
    [...AUDIOBOOKSHELF_WRITE_TOOL_NAMES],
    ['audiobookshelf_update_metadata']
  )
  assert.equal(audiobookshelfToolsEnabled(env), true)
  assert.equal(
    audiobookshelfToolsEnabled({ ...env, ECHO_API_KEY: '' }),
    false
  )
})

test('read tool calls only the local adapter and keeps both secrets out of result', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    return response({
      total: 1,
      results: [{ id: 'item_123', metadata: { title: 'Book' } }]
    })
  }

  const result = await executeAudiobookshelfTool(
    'audiobookshelf_list_items',
    { libraryId: 'lib_123', limit: 50, page: 2 },
    { fetchImpl, env }
  )

  assert.equal(
    calls[0].url,
    'http://127.0.0.1:3000/api/audiobookshelf/libraries/lib_123/items?limit=50&page=2'
  )
  assert.equal(calls[0].options.method, 'GET')
  assert.equal(calls[0].options.headers['X-Echo-Api-Key'], 'echo-secret')
  assert.equal(result.includes('echo-secret'), false)
  assert.equal(result.includes('abs-secret'), false)
})

test('write preparation re-reads exact items and formats old-to-new preview without applying', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    assert.equal(options.method, 'GET')
    return response({
      id: 'item_123',
      updatedAt: 777,
      mediaType: 'book',
      relPath: 'Sanderson/Elantris',
      metadata: {
        title: '- 02/16',
        authorName: 'Brandon - Cosmere Sanderson',
        seriesName: 'Sanderson, Brandon - Cosmere [AudioBook Series]'
      }
    })
  }

  const action = await prepareAudiobookshelfAction(
    'audiobookshelf_update_metadata',
    {
      updates: [{
        id: 'item_123',
        metadata: {
          title: 'Elantris',
          authors: [{ name: 'Brandon Sanderson' }],
          series: [{ name: 'Elantris', sequence: '1' }]
        }
      }]
    },
    { fetchImpl, env }
  )

  assert.equal(calls.length, 1)
  assert.equal(action.args.updates[0].expectedUpdatedAt, 777)
  const preview = formatAudiobookshelfPreview(action)
  assert.match(preview, /- 02\/16 -> Elantris/)
  assert.match(preview, /Brandon - Cosmere Sanderson -> Brandon Sanderson/)
  assert.match(preview, /Elantris #1/)
})

test('write execution posts only after approval path invokes it', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    return response({ success: true, applied: 1, items: [] })
  }

  const result = await executeAudiobookshelfTool(
    'audiobookshelf_update_metadata',
    {
      updates: [{
        id: 'item_123',
        expectedUpdatedAt: 777,
        metadata: { title: 'Elantris' }
      }]
    },
    { fetchImpl, env }
  )

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'http://127.0.0.1:3000/api/audiobookshelf/apply')
  assert.equal(calls[0].options.method, 'POST')
  assert.deepEqual(
    JSON.parse(calls[0].options.body),
    {
      updates: [{
        id: 'item_123',
        expectedUpdatedAt: 777,
        metadata: { title: 'Elantris' }
      }]
    }
  )
  assert.match(result, /"applied":1/)
})

test('write preparation rejects an item without a bindable updatedAt', async () => {
  await assert.rejects(
    prepareAudiobookshelfAction(
      'audiobookshelf_update_metadata',
      {
        updates: [{
          id: 'item_123',
          metadata: { title: 'Elantris' }
        }]
      },
      {
        env,
        fetchImpl: async () => response({
          id: 'item_123',
          updatedAt: null,
          mediaType: 'book',
          metadata: { title: 'Old' }
        })
      }
    ),
    error => error?.code === 'AUDIOBOOKSHELF_INVALID_UPDATED_AT'
  )
})
