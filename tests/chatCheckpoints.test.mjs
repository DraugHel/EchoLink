import test from 'node:test'
import assert from 'node:assert/strict'
import {
  chatCheckpointForTool,
  chatCheckpointKey,
  formatChatCheckpointContext,
  normalizeChatCheckpoints
} from '../server/lib/chatCheckpoints.js'

test('normalizes and deduplicates session-only research checkpoints', () => {
  const checkpoints = normalizeChatCheckpoints([
    {
      name: 'web_search',
      args: { query: '  First   Law  news ' },
      result: 'first result'
    },
    {
      name: 'web_search',
      args: { query: 'first law news' },
      result: 'duplicate result'
    },
    {
      name: 'firecrawl_scrape',
      args: { url: 'https://example.com/article#section' },
      result: 'scraped article'
    },
    { name: 'terminal', args: { command: 'whoami' }, result: 'root' }
  ])

  assert.equal(checkpoints.length, 2)
  assert.equal(checkpoints[0].args.query, 'First Law news')
  assert.equal(checkpoints[1].args.url, 'https://example.com/article#section')
  assert.equal(
    chatCheckpointKey('firecrawl_scrape', {
      url: 'https://example.com/article#other'
    }),
    checkpoints[1].key
  )
})

test('creates safe reusable checkpoints and continuation context', () => {
  const checkpoint = chatCheckpointForTool(
    'web_search',
    { query: 'EchoLink status' },
    '[1] EchoLink\nAll green'
  )

  assert.deepEqual(checkpoint.args, { query: 'EchoLink status' })
  assert.match(
    formatChatCheckpointContext([checkpoint]),
    /do not repeat this research/i
  )
  assert.equal(chatCheckpointForTool('terminal', {}, 'nope'), null)
})
