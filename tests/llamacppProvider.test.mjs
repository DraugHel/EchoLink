import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test(
  'llama.cpp nutzt die OpenAI-kompatible API mit Bearer-Key',
  async () => {
    const previous = {
      url: process.env.LLAMACPP_URL,
      key: process.env.LLAMACPP_API_KEY,
      tools: process.env.LLAMACPP_TOOLS_ENABLED,
      fetch: global.fetch
    }

    process.env.LLAMACPP_URL =
      'https://llm.example.test/v1/'
    process.env.LLAMACPP_API_KEY =
      'llama-test-secret'
    process.env.LLAMACPP_TOOLS_ENABLED = 'false'

    const requests = []

    global.fetch = async (url, options) => {
      const body = JSON.parse(options.body)
      requests.push({ url, options, body })

      if (body.stream) {
        return new Response(
          [
            'data: {"choices":[{"delta":{"reasoning_content":"denke "}}]}',
            '',
            'data: {"choices":[{"delta":{"content":"Hallo"}}]}',
            '',
            'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":2,"total_tokens":13,"prompt_tokens_details":{"cached_tokens":4}}}',
            '',
            'data: [DONE]',
            ''
          ].join('\n'),
          {
            status: 200,
            headers: {
              'Content-Type': 'text/event-stream'
            }
          }
        )
      }

      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Memory-Ergebnis'
              }
            }
          ]
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        }
      )
    }

    try {
      const provider = await import(
        `../server/providers/llamacpp.js?test=${Date.now()}`
      )

      assert.equal(provider.llamaCppConfigured(), true)
      assert.equal(provider.LLAMACPP_TOOLS_ENABLED, false)

      const writes = []
      const streamed = await provider.streamLlamaCpp(
        'gemma4-ara-abliterated',
        [
          {
            role: 'user',
            content: 'Hallo'
          }
        ],
        {
          temperature: 0.2,
          tools: [
            {
              type: 'function',
              function: {
                name: 'should_not_be_sent'
              }
            }
          ]
        },
        {
          write(chunk) {
            writes.push(chunk)
          }
        }
      )

      assert.equal(
        requests[0].url,
        'https://llm.example.test/v1/chat/completions'
      )
      assert.equal(
        requests[0].options.headers.Authorization,
        'Bearer llama-test-secret'
      )
      assert.equal(
        requests[0].body.model,
        'gemma4-ara-abliterated'
      )
      assert.equal(requests[0].body.stream, true)
      assert.equal('tools' in requests[0].body, false)
      assert.equal(streamed.fullThinking, 'denke ')
      assert.equal(streamed.fullContent, 'Hallo')
      assert.deepEqual(streamed.toolCalls, [])
      assert.deepEqual(streamed.tokenUsage, {
        promptTokens: 11,
        completionTokens: 2,
        totalTokens: 13,
        cachedTokens: 4,
        cacheWriteTokens: 0,
        cacheObserved: true
      })
      assert.match(writes.join(''), /"think":"denke "/)
      assert.match(writes.join(''), /"token":"Hallo"/)

      const completed = await provider.completeLlamaCpp(
        'gemma4-ara-abliterated',
        [
          {
            role: 'user',
            content: 'Memory'
          }
        ],
        {
          temperature: 0.3,
          maxTokens: 4000
        }
      )

      assert.equal(completed, 'Memory-Ergebnis')
      assert.equal(requests[1].body.stream, false)
      assert.equal(requests[1].body.max_tokens, 4000)
    } finally {
      global.fetch = previous.fetch

      for (const [name, value] of [
        ['LLAMACPP_URL', previous.url],
        ['LLAMACPP_API_KEY', previous.key],
        ['LLAMACPP_TOOLS_ENABLED', previous.tools]
      ]) {
        if (value === undefined) {
          delete process.env[name]
        } else {
          process.env[name] = value
        }
      }
    }
  }
)

test(
  'Chat, Agent, Memory und Modellliste routen llamacpp explizit',
  async () => {
    const [chat, agent, memory, env] = await Promise.all([
      readFile(
        new URL('../server/routes/chat.js', import.meta.url),
        'utf8'
      ),
      readFile(
        new URL('../server/lib/agentRunner.js', import.meta.url),
        'utf8'
      ),
      readFile(
        new URL('../server/routes/memory.js', import.meta.url),
        'utf8'
      ),
      readFile(
        new URL('../.env.example', import.meta.url),
        'utf8'
      )
    ])

    assert.match(
      chat,
      /activeModel\.startsWith\(['"]llamacpp\/['"]\)/
    )
    assert.match(chat, /streamFn\s*=\s*streamLlamaCpp/)
    assert.match(chat, /`\$\{LLAMACPP_URL\}\/models`/)
    assert.match(chat, /provider:\s*['"]llamacpp['"]/)
    assert.match(
      chat,
      /CHAT_CONTEXT_LLAMACPP_INPUT_TOKENS/
    )

    assert.match(
      agent,
      /model\.startsWith\(['"]llamacpp\/['"]\)/
    )
    assert.match(agent, /streamFn:\s*streamLlamaCpp/)

    assert.match(
      memory,
      /selectedModel\.startsWith\(['"]llamacpp\/['"]\)/
    )
    assert.match(memory, /completeLlamaCpp/)

    assert.match(env, /LLAMACPP_URL=/)
    assert.match(env, /LLAMACPP_API_KEY=/)
    assert.match(env, /LLAMACPP_TOOLS_ENABLED=false/)
  }
)
