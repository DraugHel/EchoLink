import test from 'node:test'
import assert from 'node:assert/strict'

import { webSearch } from '../server/lib/webSearch.js'

// Der Key ist ein Platzhalter und wird nie an einen echten Server gesendet.
const ENV = { BRAVE_API_KEY: 'test-key-not-real' }

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  })
}

function braveBody(results) {
  return { type: 'search', web: { type: 'search', results } }
}

function recorder(handler) {
  const calls = []
  const fetchFn = async (url, init) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init, calls.length)
  }
  return { calls, fetchFn }
}

const isBrave = url => url.startsWith('https://api.search.brave.com/')

test('ohne Key wird nur SearXNG benutzt', async () => {
  const { calls, fetchFn } = recorder(() =>
    jsonResponse({
      results: [{ title: 'A', content: 'B', url: 'https://a.example/' }]
    })
  )

  const result = await webSearch('hallo welt', undefined, {
    env: {},
    fetchFn
  })

  assert.equal(calls.length, 1)
  assert.ok(!isBrave(calls[0].url))
  assert.match(calls[0].url, /\/search\?q=hallo%20welt&format=json/)
  assert.equal(result.engine, 'searxng')
  assert.deepEqual(result.results, [
    { title: 'A', snippet: 'B', source: 'https://a.example/' }
  ])
})

test('mit Key fragt Brave zuerst, mit Token-Header und count=5', async () => {
  const { calls, fetchFn } = recorder(() =>
    jsonResponse(braveBody([
      {
        title: 'Titel mit <strong>Markierung</strong>',
        url: 'https://example.com/a',
        description: 'Kaffee &amp; Kuchen &#x27;heute&#x27; &lt;3'
      }
    ]))
  )

  const result = await webSearch('Wetter Wien', undefined, {
    env: ENV,
    fetchFn
  })

  assert.equal(calls.length, 1)
  const url = new URL(calls[0].url)
  assert.equal(url.origin + url.pathname, 'https://api.search.brave.com/res/v1/web/search')
  assert.equal(url.searchParams.get('q'), 'Wetter Wien')
  assert.equal(url.searchParams.get('count'), '5')
  assert.equal(calls[0].init.headers['X-Subscription-Token'], 'test-key-not-real')
  assert.equal(calls[0].init.headers.Accept, 'application/json')

  assert.equal(result.engine, 'brave')
  assert.equal(result.query, 'Wetter Wien')
  assert.deepEqual(result.results, [
    {
      title: 'Titel mit Markierung',
      snippet: "Kaffee & Kuchen 'heute' <3",
      source: 'https://example.com/a'
    }
  ])
})

test('Brave-Ergebnisse: fehlende Beschreibung ok, ohne URL verworfen, max. 5', async () => {
  const many = Array.from({ length: 8 }, (_, index) => ({
    title: `T${index}`,
    url: `https://example.com/${index}`,
    description: `D${index}`
  }))
  const { fetchFn } = recorder(() =>
    jsonResponse(braveBody([
      { title: 'ohne Beschreibung', url: 'https://example.com/x' },
      { title: 'ohne URL', description: 'weg' },
      { title: 'javascript', url: 'javascript:alert(1)', description: 'weg' },
      ...many
    ]))
  )

  const result = await webSearch('q', undefined, { env: ENV, fetchFn })

  assert.equal(result.results.length, 5)
  assert.deepEqual(result.results[0], {
    title: 'ohne Beschreibung',
    snippet: '',
    source: 'https://example.com/x'
  })
  assert.ok(result.results.every(item => /^https:\/\//.test(item.source)))
})

test('lange Anfragen werden auf 75 Wörter und 600 Zeichen gekürzt', async () => {
  const { calls, fetchFn } = recorder(() =>
    jsonResponse(braveBody([
      { title: 'T', url: 'https://example.com/', description: 'D' }
    ]))
  )

  await webSearch(
    Array.from({ length: 120 }, (_, i) => `wort${i}`).join(' '),
    undefined,
    { env: ENV, fetchFn }
  )
  const words = new URL(calls[0].url).searchParams.get('q').split(' ')
  assert.equal(words.length, 75)

  await webSearch('x'.repeat(900), undefined, { env: ENV, fetchFn })
  assert.equal(new URL(calls[1].url).searchParams.get('q').length, 600)
})

test('leere Brave-Antwort ist "keine Ergebnisse" ohne SearXNG-Umweg', async () => {
  const { calls, fetchFn } = recorder(() => jsonResponse(braveBody([])))

  const result = await webSearch('nichts', undefined, { env: ENV, fetchFn })

  assert.equal(calls.length, 1)
  assert.deepEqual(result, { error: 'No results found', query: 'nichts' })
})

test('Brave-Fehler (5xx, Netzwerk, ungültiger Key) fällt auf SearXNG zurück', async () => {
  const failures = [
    () => new Response('boom', { status: 503 }),
    () => { throw new TypeError('fetch failed') },
    () => new Response('unauthorized', { status: 401 })
  ]

  for (const failure of failures) {
    const { calls, fetchFn } = recorder(url => {
      if (isBrave(url)) return failure()
      return jsonResponse({
        results: [{ title: 'S', content: 'x', url: 'https://s.example/' }]
      })
    })

    const result = await webSearch('q', undefined, { env: ENV, fetchFn })

    assert.equal(calls.length, 2)
    assert.ok(isBrave(calls[0].url))
    assert.ok(!isBrave(calls[1].url))
    assert.equal(result.engine, 'searxng')
  }
})

test('fallen beide aus, nennt der Fehler beide Ursachen', async () => {
  const { fetchFn } = recorder(url =>
    isBrave(url)
      ? new Response('nope', { status: 402 })
      : new Response('blocked', { status: 403 })
  )

  const result = await webSearch('q', undefined, { env: ENV, fetchFn })

  assert.equal(
    result.error,
    'Brave: HTTP 402; SearXNG: Search failed: HTTP 403'
  )
  assert.ok(!('results' in result))
})

test('der API-Key taucht in keiner Fehlermeldung auf', async () => {
  const { fetchFn } = recorder(url => {
    if (isBrave(url)) throw new TypeError('fetch failed')
    return new Response('blocked', { status: 403 })
  })

  const result = await webSearch('q', undefined, { env: ENV, fetchFn })

  assert.ok(!JSON.stringify(result).includes('test-key-not-real'))
})

test('429 mit Retry-After: einmal kurz warten und wiederholen', async () => {
  const { calls, fetchFn } = recorder((url, init, count) =>
    count === 1
      ? new Response('slow down', {
          status: 429,
          headers: { 'Retry-After': '0.05' }
        })
      : jsonResponse(braveBody([
          { title: 'ok', url: 'https://example.com/', description: 'd' }
        ]))
  )

  const result = await webSearch('q', undefined, { env: ENV, fetchFn })

  assert.equal(calls.length, 2)
  assert.ok(calls.every(call => isBrave(call.url)))
  assert.equal(result.engine, 'brave')
})

test('429 mit langer Sperre wird nicht abgewartet, sondern fällt zurück', async () => {
  const { calls, fetchFn } = recorder(url =>
    isBrave(url)
      ? new Response('quota', {
          status: 429,
          headers: { 'Retry-After': '3600' }
        })
      : jsonResponse({
          results: [{ title: 'S', content: 'x', url: 'https://s.example/' }]
        })
  )

  const started = Date.now()
  const result = await webSearch('q', undefined, { env: ENV, fetchFn })

  assert.ok(Date.now() - started < 1000)
  assert.equal(calls.filter(call => isBrave(call.url)).length, 1)
  assert.equal(result.engine, 'searxng')
})

test('Abbruch durch den Aufrufer startet keinen SearXNG-Fallback', async () => {
  const controller = new AbortController()
  const { calls, fetchFn } = recorder(url => {
    controller.abort()
    const error = new Error('aborted')
    error.name = 'AbortError'
    throw error
  })

  const result = await webSearch('q', controller.signal, {
    env: ENV,
    fetchFn
  })

  assert.equal(calls.length, 1)
  assert.deepEqual(result, { error: 'Search timeout', query: 'q' })
})

const EMPTY = () => jsonResponse(braveBody([]))
const ONE = () =>
  jsonResponse(braveBody([
    { title: 'Treffer', url: 'https://example.com/t', description: 'd' }
  ]))

function braveQueries(calls) {
  return calls
    .filter(call => isBrave(call.url))
    .map(call => new URL(call.url).searchParams.get('q'))
}

async function captureLogs(run) {
  const lines = []
  const previous = console.log
  console.log = line => lines.push(String(line))
  try {
    return { result: await run(), lines }
  } finally {
    console.log = previous
  }
}

test('null Treffer: zweiter Versuch ohne Anführungszeichen und Operatoren', async () => {
  const { calls, fetchFn } = recorder((url, init, count) =>
    count === 1 ? EMPTY() : ONE()
  )

  const { result } = await captureLogs(() =>
    webSearch('"Wien Wetter" site:orf.at -reddit morgen', undefined, {
      env: ENV,
      fetchFn
    })
  )

  assert.deepEqual(braveQueries(calls), [
    '"Wien Wetter" site:orf.at -reddit morgen',
    'Wien Wetter morgen'
  ])
  assert.equal(result.engine, 'brave')
  assert.equal(result.usedQuery, 'Wien Wetter morgen')
  assert.equal(result.query, '"Wien Wetter" site:orf.at -reddit morgen')
  assert.equal(result.results.length, 1)
})

test('null Treffer: lange einfache Anfrage wird auf 8 Wörter gekürzt', async () => {
  const { calls, fetchFn } = recorder((url, init, count) =>
    count === 1 ? EMPTY() : ONE()
  )
  const words = Array.from({ length: 12 }, (_, i) => `w${i + 1}`)

  const { result } = await captureLogs(() =>
    webSearch(words.join(' '), undefined, { env: ENV, fetchFn })
  )

  assert.deepEqual(braveQueries(calls), [
    words.join(' '),
    words.slice(0, 8).join(' ')
  ])
  assert.equal(result.engine, 'brave')
})

test('null Treffer bei kurzer einfacher Anfrage: keine zweite Suche', async () => {
  const { calls, fetchFn } = recorder(EMPTY)

  const { result, lines } = await captureLogs(() =>
    webSearch('Wetter Wien morgen', undefined, { env: ENV, fetchFn })
  )

  assert.equal(calls.length, 1)
  assert.deepEqual(result, {
    error: 'No results found',
    query: 'Wetter Wien morgen'
  })
  assert.deepEqual(JSON.parse(lines[0]), {
    level: 'info',
    event: 'brave_search_empty',
    words: 3,
    retried: false,
    recovered: false
  })
})

test('auch der zweite Versuch leer: genau zwei Brave-Suchen, kein SearXNG', async () => {
  const { calls, fetchFn } = recorder(EMPTY)

  const { result } = await captureLogs(() =>
    webSearch('"a b c" site:x.de d e f g h i j k', undefined, {
      env: ENV,
      fetchFn
    })
  )

  assert.equal(calls.length, 2)
  assert.ok(calls.every(call => isBrave(call.url)))
  assert.equal(result.error, 'No results found')
})

test('Fehler im zweiten Versuch: "keine Ergebnisse", kein SearXNG', async () => {
  const { calls, fetchFn } = recorder((url, init, count) =>
    count === 1 ? EMPTY() : new Response('boom', { status: 500 })
  )

  const { result } = await captureLogs(() =>
    webSearch('"a b" c', undefined, { env: ENV, fetchFn })
  )

  assert.equal(calls.length, 2)
  assert.ok(calls.every(call => isBrave(call.url)))
  assert.equal(result.error, 'No results found')
})

test('Abbruch nach leerem ersten Versuch startet keinen zweiten', async () => {
  const controller = new AbortController()
  const { calls, fetchFn } = recorder(() => {
    controller.abort()
    return EMPTY()
  })

  const { result } = await captureLogs(() =>
    webSearch('"a b" c', controller.signal, { env: ENV, fetchFn })
  )

  assert.equal(calls.length, 1)
  assert.deepEqual(result, { error: 'Search timeout', query: '"a b" c' })
})

test('das Log zur leeren Suche enthält nur Zähler, nie den Suchbegriff', async () => {
  const { fetchFn } = recorder((url, init, count) =>
    count === 1 ? EMPTY() : ONE()
  )

  const { lines } = await captureLogs(() =>
    webSearch('"geheimer begriff" site:x.de', undefined, {
      env: ENV,
      fetchFn
    })
  )

  assert.equal(lines.length, 1)
  assert.ok(!lines[0].includes('geheimer'))
  assert.deepEqual(JSON.parse(lines[0]), {
    level: 'info',
    event: 'brave_search_empty',
    words: 3,
    retried: true,
    recovered: true
  })
})
