import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// Der Schluessel wird beim Import gelesen.
process.env.GEMINI_API_KEY = 'test-gemini-key'

const gemini = await import('../server/providers/gemini.js')
const {
  GEMINI_BASE_URL,
  GEMINI_KEY,
  buildGeminiBody,
  geminiGeneration,
  geminiSchema,
  geminiTools,
  normalizeGeminiModels,
  sendsSamplingParams,
  streamGemini,
  thinkingConfigFor,
  toGemini
} = gemini

const sink = {
  events: [],
  write(chunk) {
    const text = String(chunk)

    if (text.startsWith('data: ')) {
      this.events.push(JSON.parse(text.slice(6)))
    }

    return true
  }
}

function freshSink() {
  return { events: [], write: sink.write }
}

async function withFetch(impl, run) {
  const previous = global.fetch

  global.fetch = impl

  try {
    return await run()
  } finally {
    global.fetch = previous
  }
}

function sse(events) {
  return new Response(
    events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
    { status: 200 }
  )
}

function chunk(parts, extra = {}) {
  return { candidates: [{ content: { role: 'model', parts }, ...extra }] }
}

const USER = text => ({ role: 'user', content: text })

// ---------- Modellfamilien ----------

test('Modellfamilie wird aus dem Namen gelesen', () => {
  assert.deepEqual(geminiGeneration('gemini-3.6-flash'), { major: 3, minor: 6 })
  assert.deepEqual(geminiGeneration('gemini-2.5-pro'), { major: 2, minor: 5 })
  assert.deepEqual(geminiGeneration('gemini-3-flash-preview'), { major: 3, minor: 0 })
  assert.deepEqual(geminiGeneration('gemma-4-31b-it'), { major: 0, minor: 0 })
})

test('Sampling: ab Gemini 3 nicht senden, davor ja, per Umgebungsvariable erzwingbar', () => {
  assert.equal(sendsSamplingParams('gemini-3.6-flash', {}), false)
  assert.equal(sendsSamplingParams('gemini-3.1-pro-preview', {}), false)
  assert.equal(sendsSamplingParams('gemini-2.5-flash', {}), true)
  assert.equal(sendsSamplingParams('gemini-2.0-flash', {}), true)
  assert.equal(sendsSamplingParams('gemini-3.6-flash', { GEMINI_SAMPLING_PARAMS: '1' }), true)
  assert.equal(sendsSamplingParams('gemini-3.6-flash', { GEMINI_SAMPLING_PARAMS: 'off' }), false)
})

test('Denkmodus: Gemini 3 nutzt thinkingLevel, 2.5 thinkingBudget, aeltere kein Denken', () => {
  // Gemini 3 Flash
  assert.deepEqual(thinkingConfigFor('gemini-3.6-flash', ''), { includeThoughts: true })
  assert.deepEqual(thinkingConfigFor('gemini-3.6-flash', 'off'), { thinkingLevel: 'minimal', includeThoughts: false })
  assert.deepEqual(thinkingConfigFor('gemini-3.6-flash', 'low'), { thinkingLevel: 'low', includeThoughts: true })
  assert.deepEqual(thinkingConfigFor('gemini-3.6-flash', 'medium'), { thinkingLevel: 'medium', includeThoughts: true })
  assert.deepEqual(thinkingConfigFor('gemini-3.6-flash', 'high'), { thinkingLevel: 'high', includeThoughts: true })
  assert.deepEqual(thinkingConfigFor('gemini-3.6-flash', 'max'), { thinkingLevel: 'high', includeThoughts: true })

  // Gemini 3 Pro laesst sich nicht abschalten
  assert.deepEqual(thinkingConfigFor('gemini-3.1-pro-preview', 'off'), { thinkingLevel: 'low', includeThoughts: false })

  // Gemini 2.5
  assert.deepEqual(thinkingConfigFor('gemini-2.5-flash', ''), { includeThoughts: true })
  assert.deepEqual(thinkingConfigFor('gemini-2.5-flash', 'off'), { thinkingBudget: 0, includeThoughts: false })
  assert.deepEqual(thinkingConfigFor('gemini-2.5-pro', 'off'), { thinkingBudget: 128, includeThoughts: false })
  assert.deepEqual(thinkingConfigFor('gemini-2.5-flash', 'low'), { thinkingBudget: 1024, includeThoughts: true })
  assert.deepEqual(thinkingConfigFor('gemini-2.5-flash', 'medium'), { thinkingBudget: 8192, includeThoughts: true })
  assert.deepEqual(thinkingConfigFor('gemini-2.5-flash', 'high'), { thinkingBudget: 24576, includeThoughts: true })
  assert.deepEqual(thinkingConfigFor('gemini-2.5-pro', 'max'), { thinkingBudget: 32768, includeThoughts: true })
  assert.deepEqual(thinkingConfigFor('gemini-2.5-flash', 'max'), { thinkingBudget: 24576, includeThoughts: true })

  // aeltere und unbekannte Modelle
  assert.equal(thinkingConfigFor('gemini-2.0-flash', 'high'), null)
  assert.equal(thinkingConfigFor('gemini-1.5-pro', ''), null)
})

// ---------- Schema ----------

test('Schema: unterstuetzte Teilmenge, Grossbuchstaben-Typen, unbekannte Felder fallen weg', () => {
  const schema = geminiSchema({
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    additionalProperties: false,
    properties: {
      query: { type: 'string', description: 'Suchtext', default: 'x', title: 'Query', pattern: '^a' },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
      ratio: { type: 'number', format: 'double' },
      flag: { type: 'boolean' },
      when: { type: 'string', format: 'date-time' },
      mail: { type: 'string', format: 'email' },
      tags: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 5 },
      mode: { type: 'string', enum: ['a', 'b'] }
    },
    required: ['query', 'gibt-es-nicht']
  })

  assert.deepEqual(schema, {
    type: 'OBJECT',
    properties: {
      query: { type: 'STRING', description: 'Suchtext' },
      limit: { type: 'INTEGER', minimum: 1, maximum: 50 },
      ratio: { type: 'NUMBER', format: 'double' },
      flag: { type: 'BOOLEAN' },
      when: { type: 'STRING', format: 'date-time' },
      mail: { type: 'STRING' },
      tags: { type: 'ARRAY', items: { type: 'STRING' }, minItems: 1, maxItems: 5 },
      mode: { type: 'STRING', enum: ['a', 'b'] }
    },
    required: ['query']
  })
})

test('Schema: Nullable, anyOf, oneOf, Typlisten, allOf', () => {
  assert.deepEqual(
    geminiSchema({ type: ['string', 'null'], description: 'd' }),
    { type: 'STRING', nullable: true, description: 'd' }
  )
  assert.deepEqual(
    geminiSchema({ anyOf: [{ type: 'integer' }, { type: 'null' }] }),
    { type: 'INTEGER', nullable: true }
  )
  assert.deepEqual(
    geminiSchema({ oneOf: [{ type: 'string' }, { type: 'integer' }], description: 'x' }),
    { anyOf: [{ type: 'STRING' }, { type: 'INTEGER' }], description: 'x' }
  )
  assert.deepEqual(
    geminiSchema({ type: ['string', 'integer'] }),
    { anyOf: [{ type: 'STRING' }, { type: 'INTEGER' }] }
  )

  const merged = geminiSchema({
    allOf: [
      { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
      { properties: { b: { type: 'number' } }, required: ['b'] }
    ]
  })

  assert.deepEqual(merged.required, ['a', 'b'])
  assert.deepEqual(Object.keys(merged.properties), ['a', 'b'])
})

test('Schema: lokale $ref werden aufgeloest, Zyklen enden', () => {
  const root = {
    type: 'object',
    properties: { pet: { $ref: '#/$defs/Pet', description: 'Das Tier' } },
    $defs: { Pet: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } }
  }

  assert.deepEqual(geminiSchema(root).properties.pet, {
    type: 'OBJECT',
    properties: { name: { type: 'STRING' } },
    required: ['name'],
    description: 'Das Tier'
  })

  const cyclic = {
    type: 'object',
    properties: { next: { $ref: '#/$defs/Node' } },
    $defs: { Node: { type: 'object', properties: { next: { $ref: '#/$defs/Node' } } } }
  }

  assert.doesNotThrow(() => geminiSchema(cyclic))
  assert.equal(geminiSchema({ $ref: '#/$defs/Fehlt' }).type, 'STRING')
})

test('Schema: Enums nur als Text, freie Objekte als JSON-Text, Array ohne items', () => {
  assert.deepEqual(
    geminiSchema({ type: 'integer', enum: [1, 2, 3], description: 'Stufe' }),
    { type: 'INTEGER', description: 'Stufe (erlaubt: 1, 2, 3)' }
  )
  assert.deepEqual(
    geminiSchema({ type: 'string', const: 'fest' }),
    { type: 'STRING', enum: ['fest'] }
  )
  assert.deepEqual(
    geminiSchema({ type: 'object', description: 'Optionen' }),
    { type: 'STRING', description: 'Optionen (JSON-Objekt als Text)' }
  )
  assert.deepEqual(geminiSchema({ type: 'array' }).items, { type: 'STRING' })
  assert.deepEqual(geminiSchema(null), { type: 'STRING' })
  assert.deepEqual(geminiSchema({ properties: { a: { type: 'string' } } }).type, 'OBJECT')
})

test('Werkzeuge: Funktionsdeklarationen, ohne Parameter kein parameters-Feld', () => {
  const tools = geminiTools([
    {
      type: 'function',
      function: {
        name: 'web_search',
        description: 'Suche',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false }
      }
    },
    { type: 'function', function: { name: 'list_things', description: 'Ohne Parameter', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'no_params', description: 'Kein Schema' } },
    { type: 'function', function: { description: 'ohne Namen' } },
    null
  ])

  assert.equal(tools.length, 1)

  const declarations = tools[0].functionDeclarations

  assert.deepEqual(declarations.map(item => item.name), ['web_search', 'list_things', 'no_params'])
  assert.deepEqual(declarations[0].parameters, {
    type: 'OBJECT',
    properties: { query: { type: 'STRING' } },
    required: ['query']
  })
  assert.equal('parameters' in declarations[1], false)
  assert.equal('parameters' in declarations[2], false)

  assert.deepEqual(geminiTools([]), [])
})

// ---------- Nachrichten ----------

test('System, Nutzer, Bilder und Antworten werden umgesetzt', () => {
  const png = 'iVBORw0KGgoAAAANSUhEUg=='
  const { systemInstruction, contents } = toGemini([
    { role: 'system', content: 'Regel A' },
    { role: 'system', content: 'Regel B' },
    { role: 'user', content: 'Hallo' },
    { role: 'assistant', content: 'Hi!' },
    { role: 'user', content: 'Was ist das?', images: [png] }
  ])

  assert.deepEqual(systemInstruction, { parts: [{ text: 'Regel A\n\nRegel B' }] })
  assert.equal(contents.length, 3)
  assert.deepEqual(contents[0], { role: 'user', parts: [{ text: 'Hallo' }] })
  assert.deepEqual(contents[1], { role: 'model', parts: [{ text: 'Hi!' }] })
  assert.equal(contents[2].parts[0].inlineData.data, png)
  assert.match(contents[2].parts[0].inlineData.mimeType, /^image\//)
  assert.deepEqual(contents[2].parts[1], { text: 'Was ist das?' })

  assert.equal(toGemini([USER('x')]).systemInstruction, undefined)
})

test('Gleiche Rollen hintereinander werden zusammengefasst, leere Nachrichten fallen weg', () => {
  const { contents } = toGemini([
    USER('a'),
    { role: 'user', content: '' },
    USER('b'),
    { role: 'assistant', content: 'x' },
    { role: 'assistant', content: 'y' },
    USER('c')
  ])

  assert.deepEqual(contents, [
    { role: 'user', parts: [{ text: 'a' }, { text: 'b' }] },
    { role: 'model', parts: [{ text: 'x' }, { text: 'y' }] },
    { role: 'user', parts: [{ text: 'c' }] }
  ])
})

test('Beginn mit Modell-Beitrag und Ende mit Modell-Beitrag werden abgesichert', () => {
  const start = toGemini([{ role: 'assistant', content: 'Antwort' }, USER('Frage')])

  assert.equal(start.contents[0].role, 'user')
  assert.match(start.contents[0].parts[0].text, /gekuerzt/)

  const end = toGemini([USER('Frage'), { role: 'assistant', content: 'Antwort' }])

  assert.equal(end.contents.at(-1).role, 'user')
  assert.match(end.contents.at(-1).parts[0].text, /fahre fort/i)
})

test('Werkzeugrunde mit rohen Teilen: Signaturen kommen unveraendert zurueck', () => {
  const rawParts = [
    { text: 'Ich suche kurz.', thought: true },
    { functionCall: { id: 'fc-1', name: 'web_search', args: { query: 'Haiku' } }, thoughtSignature: 'SIG-A' },
    { functionCall: { name: 'terminal', args: { command: 'uptime' } } }
  ]
  const messages = [
    USER('Recherchiere'),
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'fc-1', geminiCallId: 'fc-1', function: { name: 'web_search', arguments: { query: 'Haiku' } } },
        { id: 'call_gemini_1', function: { name: 'terminal', arguments: { command: 'uptime' } } }
      ],
      _raw: { provider: 'gemini', parts: rawParts }
    },
    { role: 'tool', tool_call_id: 'fc-1', content: 'Treffer eins' },
    { role: 'tool', tool_call_id: 'call_gemini_1', content: 'up 78 days' }
  ]
  const { contents } = toGemini(messages)

  assert.equal(contents.length, 3)
  assert.deepEqual(contents[1], { role: 'model', parts: rawParts })

  // Kopie, nicht dieselben Objekte (Anfragen duerfen den Zustand nicht veraendern).
  assert.notEqual(contents[1].parts[1], rawParts[1])
  contents[1].parts[1].thoughtSignature = 'GEAENDERT'
  assert.equal(rawParts[1].thoughtSignature, 'SIG-A')

  // Beide Antworten in EINEM Nutzer-Beitrag, mit Namen und (falls vorhanden) API-ID.
  assert.deepEqual(contents[2], {
    role: 'user',
    parts: [
      { functionResponse: { name: 'web_search', id: 'fc-1', response: { result: 'Treffer eins' } } },
      { functionResponse: { name: 'terminal', response: { result: 'up 78 days' } } }
    ]
  })
})

test('Werkzeugrunde ohne rohe Teile (aeltere Nachrichten): functionCall aus tool_calls', () => {
  const { contents } = toGemini([
    USER('Zeit?'),
    {
      role: 'assistant',
      content: 'Moment.',
      tool_calls: [{ id: 't1', function: { name: 'terminal', arguments: '{"command":"date"}' } }]
    },
    { role: 'tool', tool_call_id: 't1', content: 'Mo' }
  ])

  assert.deepEqual(contents[1], {
    role: 'model',
    parts: [
      { text: 'Moment.' },
      { functionCall: { name: 'terminal', args: { command: 'date' } } }
    ]
  })
  assert.deepEqual(contents[2].parts[0].functionResponse, { name: 'terminal', response: { result: 'Mo' } })
})

test('Werkzeugantwort ohne tool_call_id: Name aus der Reihenfolge, sonst "tool"', () => {
  const { contents } = toGemini([
    USER('x'),
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'a', function: { name: 'one', arguments: {} } },
        { id: 'b', function: { name: 'two', arguments: {} } }
      ]
    },
    { role: 'tool', content: 'erste' },
    { role: 'tool', content: 'zweite' },
    { role: 'tool', content: 'dritte' }
  ])

  assert.deepEqual(
    contents[2].parts.map(part => part.functionResponse.name),
    ['one', 'two', 'tool']
  )
})

test('mehrere Werkzeugrunden nacheinander bleiben getrennt und vollstaendig', () => {
  const raw = (id, name) => ({
    provider: 'gemini',
    parts: [{ functionCall: { name, args: {} }, thoughtSignature: `sig-${id}` }]
  })
  const call = (id, name) => ({ id, function: { name, arguments: {} } })
  const { contents } = toGemini([
    USER('Auftrag'),
    { role: 'assistant', content: '', tool_calls: [call('1', 'a')], _raw: raw('1', 'a') },
    { role: 'tool', tool_call_id: '1', content: 'r1' },
    { role: 'assistant', content: '', tool_calls: [call('2', 'b')], _raw: raw('2', 'b') },
    { role: 'tool', tool_call_id: '2', content: 'r2' }
  ])

  assert.deepEqual(contents.map(item => item.role), ['user', 'model', 'user', 'model', 'user'])
  assert.equal(contents[1].parts[0].thoughtSignature, 'sig-1')
  assert.equal(contents[3].parts[0].thoughtSignature, 'sig-2')
  assert.equal(contents[4].parts[0].functionResponse.name, 'b')
})

// ---------- Anfrage ----------

test('Anfrage Gemini 3: Denk-Zusammenfassung an, keine Sampling-Werte, Werkzeuge nur wenn vorhanden', () => {
  const tool = {
    type: 'function',
    function: { name: 'web_search', description: 'Suche', parameters: { type: 'object', properties: { query: { type: 'string' } } } }
  }
  const body = buildGeminiBody(
    'gemini-3.6-flash',
    [{ role: 'system', content: 'Sys' }, USER('Hi')],
    { temperature: 0.7, top_p: 0.9, top_k: 40, reasoningEffort: '', tools: [tool] }
  )

  assert.deepEqual(body.systemInstruction, { parts: [{ text: 'Sys' }] })
  assert.equal(body.generationConfig.maxOutputTokens, 32768)
  assert.deepEqual(body.generationConfig.thinkingConfig, { includeThoughts: true })
  assert.equal('temperature' in body.generationConfig, false)
  assert.equal('topP' in body.generationConfig, false)
  assert.equal('topK' in body.generationConfig, false)
  assert.equal(body.tools[0].functionDeclarations[0].name, 'web_search')

  const noTools = buildGeminiBody('gemini-3.6-flash', [USER('Hi')], { tools: [] })

  assert.equal('tools' in noTools, false)
  assert.equal(buildGeminiBody('gemini-3.6-flash', [USER('Hi')], { tools: [], maxTokens: 600 }).generationConfig.maxOutputTokens, 600)
})

test('Anfrage Gemini 2.5: Sampling-Werte und Denkbudget', () => {
  const body = buildGeminiBody(
    'gemini-2.5-flash',
    [USER('Hi')],
    { temperature: 1.4, top_p: 0.8, top_k: 20, reasoningEffort: 'medium', tools: [] }
  )

  assert.equal(body.generationConfig.temperature, 1.4)
  assert.equal(body.generationConfig.topP, 0.8)
  assert.equal(body.generationConfig.topK, 20)
  assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingBudget: 8192, includeThoughts: true })
  assert.equal(
    buildGeminiBody('gemini-2.5-flash', [USER('x')], { temperature: 9, tools: [] }).generationConfig.temperature,
    2
  )
})

// ---------- Streaming ----------

const SIGNED_CALL = {
  functionCall: { name: 'web_search', args: { query: 'Haiku 5.5' } },
  thoughtSignature: 'SIG-1'
}

test('Stream: Text, Denk-Zusammenfassung, Werkzeugaufruf, Nutzung und rohe Teile', async () => {
  const out = freshSink()
  let request

  const result = await withFetch(async (url, init) => {
    request = { url: String(url), init, body: JSON.parse(init.body) }

    return sse([
      chunk([{ text: 'Ich ueberlege ', thought: true }]),
      chunk([{ text: 'kurz.', thought: true }]),
      chunk([{ text: 'Ich suche ' }]),
      chunk([{ text: 'das.' }]),
      chunk([SIGNED_CALL], { finishReason: 'STOP' }),
      {
        usageMetadata: {
          promptTokenCount: 1000,
          candidatesTokenCount: 40,
          thoughtsTokenCount: 60,
          cachedContentTokenCount: 800,
          totalTokenCount: 1100
        }
      }
    ])
  }, () => streamGemini(
    'gemini-3.6-flash',
    [{ role: 'system', content: 'S' }, USER('Suche Haiku 5.5')],
    { tools: [{ type: 'function', function: { name: 'web_search', description: 'd', parameters: { type: 'object', properties: { query: { type: 'string' } } } } }] },
    out
  ))

  assert.equal(
    request.url,
    `${GEMINI_BASE_URL}/models/gemini-3.6-flash:streamGenerateContent?alt=sse`
  )
  assert.equal(request.init.method, 'POST')
  assert.equal(request.init.headers['x-goog-api-key'], GEMINI_KEY)
  assert.equal(request.init.headers['content-type'], 'application/json')
  assert.deepEqual(request.body.systemInstruction, { parts: [{ text: 'S' }] })
  assert.deepEqual(request.body.contents, [{ role: 'user', parts: [{ text: 'Suche Haiku 5.5' }] }])

  assert.equal(result.fullContent, 'Ich suche das.')
  assert.equal(result.fullThinking, 'Ich ueberlege kurz.')
  assert.equal(result.completed, true)
  assert.equal(result.toolCalls.length, 1)
  assert.match(result.toolCalls[0].id, /^call_gemini_0_/)
  assert.deepEqual(result.toolCalls[0].function, { name: 'web_search', arguments: { query: 'Haiku 5.5' } })

  assert.deepEqual(result.tokenUsage, {
    promptTokens: 1000,
    completionTokens: 100,
    totalTokens: 1100,
    cachedTokens: 800,
    cacheWriteTokens: 0,
    cacheObserved: true
  })

  // An den Client gehen Text- und Denk-Ereignisse.
  assert.deepEqual(
    out.events.filter(event => event.token).map(event => event.token),
    ['Ich suche ', 'das.']
  )
  assert.deepEqual(
    out.events.filter(event => event.think).map(event => event.think),
    ['Ich ueberlege ', 'kurz.']
  )

  // Rohe Teile: Text-Brocken zusammengefuegt, Signatur unveraendert.
  assert.equal(result.rawOutput.provider, 'gemini')
  assert.deepEqual(result.rawOutput.parts, [
    { text: 'Ich ueberlege kurz.', thought: true },
    { text: 'Ich suche das.' },
    SIGNED_CALL
  ])
})

test('Stream: die Werkzeugrunde laesst sich mit rawOutput und tool_calls direkt weiterfuehren', async () => {
  const first = await withFetch(
    async () => sse([chunk([{ text: 'Suche.' }, { ...SIGNED_CALL, functionCall: { id: 'api-7', name: 'web_search', args: { query: 'x' } } }], { finishReason: 'STOP' })]),
    () => streamGemini('gemini-3.6-flash', [USER('x')], { tools: [] }, freshSink())
  )

  assert.equal(first.toolCalls[0].id, 'api-7')
  assert.equal(first.toolCalls[0].geminiCallId, 'api-7')

  let second

  await withFetch(async (url, init) => {
    second = JSON.parse(init.body)

    return sse([chunk([{ text: 'Fertig.' }], { finishReason: 'STOP' })])
  }, () => streamGemini('gemini-3.6-flash', [
    USER('x'),
    { role: 'assistant', content: first.fullContent, tool_calls: first.toolCalls, _raw: first.rawOutput },
    { role: 'tool', tool_call_id: first.toolCalls[0].id, content: 'Ergebnis' }
  ], { tools: [] }, freshSink()))

  assert.equal(second.contents.length, 3)
  assert.equal(second.contents[1].role, 'model')
  assert.equal(second.contents[1].parts[1].thoughtSignature, 'SIG-1')
  assert.deepEqual(second.contents[2].parts[0].functionResponse, {
    name: 'web_search',
    id: 'api-7',
    response: { result: 'Ergebnis' }
  })
})

test('Stream: ohne Werkzeugaufruf kein rawOutput, parallele Aufrufe bekommen eigene IDs', async () => {
  const plain = await withFetch(
    async () => sse([chunk([{ text: 'Hallo', thoughtSignature: 'X' }], { finishReason: 'STOP' })]),
    () => streamGemini('gemini-3.6-flash', [USER('x')], { tools: [] }, freshSink())
  )

  assert.equal(plain.rawOutput, null)
  assert.equal(plain.toolCalls.length, 0)
  assert.equal(plain.tokenUsage.cacheObserved, false)

  const parallel = await withFetch(
    async () => sse([chunk([
      { functionCall: { name: 'a', args: {} }, thoughtSignature: 'S1' },
      { functionCall: { name: 'b', args: { x: 1 } } }
    ], { finishReason: 'STOP' })]),
    () => streamGemini('gemini-3.6-flash', [USER('x')], { tools: [] }, freshSink())
  )

  assert.equal(parallel.toolCalls.length, 2)
  assert.notEqual(parallel.toolCalls[0].id, parallel.toolCalls[1].id)
  assert.equal(parallel.rawOutput.parts.length, 2)
})

test('Stream ohne Abschluss gilt als nicht fertig, Daten ohne Zeilenende am Schluss werden gelesen', async () => {
  const cut = await withFetch(
    async () => sse([chunk([{ text: 'Hal' }])]),
    () => streamGemini('gemini-3.6-flash', [USER('x')], { tools: [] }, freshSink())
  )

  assert.equal(cut.completed, false)
  assert.equal(cut.fullContent, 'Hal')

  const noNewline = await withFetch(
    async () => new Response(`data: ${JSON.stringify(chunk([{ text: 'Ende' }], { finishReason: 'STOP' }))}`, { status: 200 }),
    () => streamGemini('gemini-3.6-flash', [USER('x')], { tools: [] }, freshSink())
  )

  assert.equal(noNewline.fullContent, 'Ende')
  assert.equal(noNewline.completed, true)
})

test('Fehler: HTTP-Status werden eingestuft, Schluessel fehlt wird erkannt', async () => {
  await withFetch(
    async () => new Response('{"error":{"code":429,"message":"Quota exceeded","status":"RESOURCE_EXHAUSTED"}}', { status: 429 }),
    async () => {
      await assert.rejects(
        streamGemini('gemini-3.6-flash', [USER('x')], { tools: [] }, freshSink()),
        error => error.retryable === true && /^Gemini 429: Quota exceeded/.test(error.message)
      )
    }
  )

  await withFetch(
    async () => new Response('{"error":{"code":400,"message":"API key not valid"}}', { status: 400 }),
    async () => {
      await assert.rejects(
        streamGemini('gemini-3.6-flash', [USER('x')], { tools: [] }, freshSink()),
        error => error.retryable === false && /API key not valid/.test(error.message)
      )
    }
  )

  const abort = new Error('aborted')

  abort.name = 'AbortError'

  await withFetch(async () => { throw abort }, async () => {
    await assert.rejects(
      streamGemini('gemini-3.6-flash', [USER('x')], { tools: [] }, freshSink()),
      error => error === abort
    )
  })
})

test('Fehler im Stream: blockierte Antwort, Blockade der Anfrage, Fehlerereignis, fehlerhafter Aufruf', async () => {
  const run = events => withFetch(
    async () => sse(events),
    () => streamGemini('gemini-3.6-flash', [USER('x')], { tools: [] }, freshSink())
  )

  await assert.rejects(
    run([chunk([], { finishReason: 'SAFETY' })]),
    error => error.retryable === false && /blockiert \(SAFETY\)/.test(error.message)
  )

  // Mit Teilantwort wird nichts verworfen.
  const partial = await run([chunk([{ text: 'Teil' }], { finishReason: 'SAFETY' })])

  assert.equal(partial.fullContent, 'Teil')

  await assert.rejects(
    run([{ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }]),
    error => error.retryable === false && /PROHIBITED_CONTENT/.test(error.message)
  )

  await assert.rejects(
    run([{ error: { code: 503, status: 'UNAVAILABLE', message: 'overloaded' } }]),
    error => error.retryable === true && /overloaded/.test(error.message)
  )

  await assert.rejects(
    run([{ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'kaputt' } }]),
    error => error.retryable === false
  )

  await assert.rejects(
    run([chunk([], { finishReason: 'MALFORMED_FUNCTION_CALL' })]),
    error => error.retryable === true && error.partialOutput === false
  )
})

test('Lehnt das Modell das Denken ab, wird einmal ohne thinkingConfig wiederholt und gemerkt', async () => {
  const bodies = []
  let calls = 0
  const impl = async (url, init) => {
    bodies.push(JSON.parse(init.body))
    calls++

    return calls === 1
      ? new Response('{"error":{"code":400,"message":"Thinking is not supported for this model"}}', { status: 400 })
      : sse([chunk([{ text: 'OK' }], { finishReason: 'STOP' })])
  }

  const result = await withFetch(impl, () =>
    streamGemini('gemini-3.9-test-a', [USER('x')], { tools: [], reasoningEffort: 'high' }, freshSink())
  )

  assert.equal(result.fullContent, 'OK')
  assert.equal(bodies.length, 2)
  assert.ok(bodies[0].generationConfig.thinkingConfig)
  assert.equal('thinkingConfig' in bodies[1].generationConfig, false)

  // Gemerkt: die naechste Anfrage sendet es gar nicht erst.
  bodies.length = 0
  calls = 10

  await withFetch(impl, () =>
    streamGemini('gemini-3.9-test-a', [USER('y')], { tools: [], reasoningEffort: 'high' }, freshSink())
  )

  assert.equal(bodies.length, 1)
  assert.equal('thinkingConfig' in bodies[0].generationConfig, false)
})

test('Lehnt das Modell Sampling ab, wird einmal ohne Temperatur, topP, topK wiederholt', async () => {
  const bodies = []
  let calls = 0

  const result = await withFetch(async (url, init) => {
    bodies.push(JSON.parse(init.body))
    calls++

    return calls === 1
      ? new Response('{"error":{"code":400,"message":"temperature is not supported for this model"}}', { status: 400 })
      : sse([chunk([{ text: 'OK' }], { finishReason: 'STOP' })])
  }, () => streamGemini(
    'gemini-2.4-test-b',
    [USER('x')],
    { tools: [], temperature: 0.5, top_p: 0.9, top_k: 40 },
    freshSink()
  ))

  assert.equal(result.fullContent, 'OK')
  assert.equal(bodies[0].generationConfig.temperature, 0.5)
  assert.equal('temperature' in bodies[1].generationConfig, false)
  assert.equal('topP' in bodies[1].generationConfig, false)
  assert.equal('topK' in bodies[1].generationConfig, false)
})

test('Andere 400-Fehler (z.B. fehlende Signatur) werden nicht verschleiert und nicht wiederholt', async () => {
  let calls = 0

  await withFetch(async () => {
    calls++

    return new Response(
      '{"error":{"code":400,"message":"Function call web_search in the 1. content block is missing a thought_signature."}}',
      { status: 400 }
    )
  }, async () => {
    await assert.rejects(
      streamGemini('gemini-3.6-flash', [USER('x')], { tools: [], reasoningEffort: 'high', temperature: 1 }, freshSink()),
      error => /missing a thought_signature/.test(error.message)
    )
  })

  assert.equal(calls, 1)
})

// ---------- Modellliste ----------

test('Modellliste: nur Chat-Modelle, mit Praefix, neueste zuerst', () => {
  const models = normalizeGeminiModels({
    models: [
      { name: 'models/gemini-3.5-flash', supportedGenerationMethods: ['generateContent', 'countTokens'] },
      { name: 'models/gemini-3.6-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
      { name: 'models/gemini-3.1-flash-image', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-2.5-flash-preview-tts', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-live-3.0-flash', supportedGenerationMethods: ['bidiGenerateContent'] },
      { name: 'models/gemma-4-31b-it', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/imagen-4', supportedGenerationMethods: ['predict'] },
      { supportedGenerationMethods: ['generateContent'] }
    ]
  })

  assert.deepEqual(models, [
    { name: 'google/gemini-3.6-flash', provider: 'google' },
    { name: 'google/gemini-3.5-flash', provider: 'google' },
    { name: 'google/gemini-2.5-pro', provider: 'google' }
  ])
  assert.deepEqual(normalizeGeminiModels({}), [])
  assert.deepEqual(normalizeGeminiModels(null), [])
})

// ---------- Anbindung ----------

test('Routing: google/ geht an den Gemini-Anbieter, Name ohne Praefix', async () => {
  const { resolveProvider } = await import('../server/providers/index.js')
  const provider = resolveProvider('google/gemini-3.6-flash')

  assert.equal(provider.name, 'google')
  assert.equal(provider.label, 'Google Gemini')
  assert.equal(provider.providerModel, 'gemini-3.6-flash')
  assert.equal(provider.streamFn, streamGemini)
  assert.equal(provider.configured, true)

  // Unpraefixierte gemini-Namen bleiben bei Ollama (z.B. Ollama Cloud).
  assert.equal(resolveProvider('gemini-3-flash-preview:cloud').name, 'ollama')
  assert.equal(resolveProvider('claude-sonnet-5-5').name, 'anthropic')
})

test('Verdrahtung: Modellliste, Kontextbudget und Einstellungen kennen Google', async () => {
  const read = file => readFile(new URL(`../${file}`, import.meta.url), 'utf8')
  const [chat, index, panel] = await Promise.all([
    read('server/routes/chat.js'),
    read('server/providers/index.js'),
    read('client/src/components/SettingsPanel.jsx')
  ])

  assert.match(chat, /from '\.\.\/providers\/gemini\.js'/)
  assert.match(chat, /name: 'google',\s*\n\s*enabled: Boolean\(GEMINI_KEY\)/)
  assert.match(chat, /x-goog-api-key/)
  assert.match(chat, /normalizeGeminiModels\(data\)/)
  assert.match(chat, /source: 'builtin:gemini'/)

  assert.match(index, /from '\.\/gemini\.js'/)
  assert.match(index, /prefix: 'google\/'/)

  assert.match(panel, /google: 'Google Gemini'/)
  assert.match(panel, /form\.model\.startsWith\('google\/'\)/)

  // Der Chat spricht nie direkt mit einem Stream-Anbieter.
  assert.doesNotMatch(chat, /\bstreamGemini\b/)
})
