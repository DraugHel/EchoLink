import test from 'node:test'
import assert from 'node:assert/strict'
import {
  audiobookshelfConfig,
  createAudiobookshelfClient,
  normalizeAudiobookshelfUpdates,
  sanitizeBookMetadata
} from '../server/lib/audiobookshelf.js'

test('audiobookshelfConfig strips trailing slash and requires key', () => {
  const config = audiobookshelfConfig({
    AUDIOBOOKSHELF_URL: 'https://abs.example.test/',
    AUDIOBOOKSHELF_API_KEY: 'secret',
    AUDIOBOOKSHELF_TIMEOUT_MS: '20000'
  })
  assert.equal(config.configured, true)
  assert.equal(config.baseUrl, 'https://abs.example.test')
  assert.equal(config.apiKey, 'secret')
  assert.equal(config.timeoutMs, 20000)
})

test('sanitizeBookMetadata accepts only supported book fields', () => {
  assert.deepEqual(
    sanitizeBookMetadata({
      title: ' Leviathan Wakes ',
      authors: [{ name: ' James S. A. Corey ' }],
      series: [{ name: ' The Expanse ', sequence: ' 1 ' }],
      narrators: ['Jefferson Mays'],
      explicit: false
    }),
    {
      title: 'Leviathan Wakes',
      narrators: ['Jefferson Mays'],
      authors: [{ name: 'James S. A. Corey' }],
      series: [{ name: 'The Expanse', sequence: '1' }],
      explicit: false
    }
  )
  assert.throws(
    () => sanitizeBookMetadata({ coverPath: '/tmp/cover.jpg' }),
    /nicht erlaubte Felder/
  )
})

test('normalizeAudiobookshelfUpdates requires optimistic concurrency value', () => {
  assert.throws(
    () => normalizeAudiobookshelfUpdates({
      updates: [{ id: 'li_abc123', metadata: { title: 'Book' } }]
    }),
    /expectedUpdatedAt/
  )

  assert.deepEqual(
    normalizeAudiobookshelfUpdates({
      updates: [{
        id: 'li_abc123',
        expectedUpdatedAt: 123,
        metadata: { series: [{ name: 'Series', sequence: '2' }] }
      }]
    }),
    [{
      id: 'li_abc123',
      expectedUpdatedAt: 123,
      metadata: { series: [{ name: 'Series', sequence: '2' }] }
    }]
  )
})

test('client keeps bearer token server-side and compacts item payloads', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    return new Response(JSON.stringify({
      id: 'li_abc123',
      libraryId: 'lib_abc123',
      relPath: 'Author/Series/Book',
      updatedAt: 456,
      mediaType: 'book',
      media: {
        metadata: {
          title: 'Book',
          authors: [{ id: 'aut_1', name: 'Author' }],
          series: [{ id: 'ser_1', name: 'Series', sequence: '1' }],
          description: 'Description'
        },
        tags: ['tag']
      }
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  const client = createAudiobookshelfClient({
    baseUrl: 'https://abs.example.test',
    apiKey: 'top-secret',
    fetchImpl
  })
  const item = await client.getItem('li_abc123')

  assert.equal(calls[0].url, 'https://abs.example.test/api/items/li_abc123')
  assert.equal(calls[0].options.headers.Authorization, 'Bearer top-secret')
  assert.deepEqual(item.metadata.authors, [{ name: 'Author' }])
  assert.deepEqual(item.metadata.series, [{ name: 'Series', sequence: '1' }])
  assert.equal(item.updatedAt, 456)
})
