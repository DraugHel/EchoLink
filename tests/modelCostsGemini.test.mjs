import test from 'node:test'
import assert from 'node:assert/strict'

import {
  estimateModelUsageCost,
  providerForModel,
  resolveModelPricing
} from '../server/lib/modelCosts.js'

const at = iso => Math.floor(Date.parse(iso) / 1000)
const NOW = at('2026-10-15T12:00:00Z')

function price(model, when = NOW) {
  return resolveModelPricing(model, when)
}

test('google/ gehoert zum Anbieter google, aehnliche Namen bleiben bei Ollama', () => {
  assert.equal(providerForModel('google/gemini-3.6-flash'), 'google')
  assert.equal(providerForModel('GOOGLE/gemini-3.6-flash'), 'google')
  assert.equal(providerForModel('gemini-3-flash-preview:cloud'), 'ollama-cloud')
  assert.equal(providerForModel('gemini-3-flash-preview'), 'ollama')
  assert.equal(providerForModel('claude-sonnet-5-5'), 'anthropic')
})

test('Preise Stand 15.10.2026 (Standard, bezahlte Stufe, USD je 1 Mio. Token)', () => {
  const table = {
    'gemini-3.8-flash': [0.75, 0.075, 3.75],
    'gemini-3.6-flash': [0.75, 0.075, 3.75],
    'gemini-4-argon': [2.0, 0.1, 10.0],
    'gemini-3.5-flash-lite': [0.3, 0.03, 2.5],
    'gemini-3.1-flash-lite': [0.25, 0.025, 1.5],
    'gemini-3.1-pro-preview': [2.0, 0.2, 12.0],
    'gemini-3.1-pro-preview-customtools': [2.0, 0.2, 12.0],
    'gemini-3-flash-preview': [0.5, 0.05, 3.0],
    'gemini-2.5-pro': [1.25, 0.125, 10.0],
    'gemini-2.5-flash': [0.3, 0.03, 2.5]
  }

  for (const [id, [input, cached, output]] of Object.entries(table)) {
    const found = price(`google/${id}`)

    assert.ok(found, id)
    assert.equal(found.inputPerMillion, input, `${id} input`)
    assert.equal(found.cachedPerMillion, cached, `${id} cached`)
    assert.equal(found.outputPerMillion, output, `${id} output`)
    // Implizites Caching kennt keinen Aufschlag fuers Schreiben.
    assert.equal(found.cacheWritePerMillion, input, `${id} cache write`)
    assert.equal(found.local, false)
    assert.match(found.key, new RegExp(`^google:${id.replace(/\./g, '\\.')}:`))
    assert.match(found.source, /Google Gemini API pricing/)
  }
})

test('Einfuehrungspreise laufen aus: Flash 3.6/3.8 am 1.1.2027 (doppelt), Argon am 1.12.2026 (doppelt)', () => {
  for (const id of ['gemini-3.6-flash', 'gemini-3.8-flash']) {
    const last = price(`google/${id}`, at('2026-12-31T23:59:59Z'))
    const first = price(`google/${id}`, at('2027-01-01T00:00:00Z'))

    assert.deepEqual(
      [last.inputPerMillion, last.cachedPerMillion, last.outputPerMillion],
      [0.75, 0.075, 3.75]
    )
    assert.deepEqual(
      [first.inputPerMillion, first.cachedPerMillion, first.outputPerMillion],
      [1.5, 0.15, 7.5]
    )
    assert.notEqual(last.key, first.key, 'eigener Schluessel je Zeitraum')
    assert.match(last.key, /intro-until-2026-12-31$/)
    assert.match(first.key, /from-2027-01-01$/)
  }

  const argonBefore = price('google/gemini-4-argon', at('2026-11-30T23:59:59Z'))
  const argonAfter = price('google/gemini-4-argon', at('2026-12-01T00:00:00Z'))

  assert.deepEqual(
    [argonBefore.inputPerMillion, argonBefore.cachedPerMillion, argonBefore.outputPerMillion],
    [2, 0.1, 10]
  )
  assert.deepEqual(
    [argonAfter.inputPerMillion, argonAfter.cachedPerMillion, argonAfter.outputPerMillion],
    [4, 0.2, 20]
  )
  assert.notEqual(argonBefore.key, argonAfter.key)

  // Modelle ohne befristeten Preis aendern sich nicht.
  assert.deepEqual(
    price('google/gemini-3.5-flash-lite', at('2030-01-01T00:00:00Z')).outputPerMillion,
    2.5
  )
})

test('Kostenrechnung: Cache-Treffer, Rest und Ausgabe inklusive Denk-Token', () => {
  // 1 Mio. Prompt (davon 800k aus dem Cache) + 100k Ausgabe (inkl. Denken)
  const cost = estimateModelUsageCost(
    'google/gemini-3.6-flash',
    {
      promptTokens: 1_000_000,
      completionTokens: 100_000,
      cachedTokens: 800_000,
      cacheWriteTokens: 0
    },
    NOW
  )

  assert.equal(cost.priced, true)
  assert.equal(cost.provider, 'google')
  assert.match(cost.pricingKey, /^google:gemini-3\.6-flash:intro-until-2026-12-31$/)
  // 200k * 0,75 + 800k * 0,075 + 100k * 3,75 = 150.000 + 60.000 + 375.000 = 585.000 -> 0,585 USD
  assert.ok(Math.abs(cost.costUsd - 0.585) < 1e-9, String(cost.costUsd))
  assert.deepEqual(cost.components, {
    uncachedTokens: 200_000,
    cachedTokens: 800_000,
    cacheWriteTokens: 0,
    completionTokens: 100_000
  })

  const after = estimateModelUsageCost(
    'google/gemini-3.6-flash',
    { promptTokens: 1_000_000, completionTokens: 100_000, cachedTokens: 800_000 },
    at('2027-02-01T00:00:00Z')
  )

  // 200k * 1,5 + 800k * 0,15 + 100k * 7,5 = 300.000 + 120.000 + 750.000
  assert.ok(Math.abs(after.costUsd - 1.17) < 1e-9, String(after.costUsd))

  const pro = estimateModelUsageCost(
    'google/gemini-3.1-pro-preview',
    { promptTokens: 100_000, completionTokens: 10_000, cachedTokens: 0 },
    NOW
  )

  // 100k * 2 + 10k * 12 = 320.000 -> 0,32 USD
  assert.ok(Math.abs(pro.costUsd - 0.32) < 1e-9, String(pro.costUsd))
})

test('Pro-Modelle: Preis fuer Prompts bis 200k Token, mit Hinweis im Schluessel', () => {
  for (const id of ['gemini-3.1-pro-preview', 'gemini-3.1-pro-preview-customtools', 'gemini-2.5-pro']) {
    assert.match(price(`google/${id}`).key, /:standard-le200k:2026-10-15$/, id)
  }

  assert.match(price('google/gemini-3.6-flash').key, /intro/)
  assert.match(price('google/gemini-3.5-flash-lite').key, /:standard:2026-10-15$/)
})

test('Unbekannte oder nicht gelistete Modelle bleiben bewusst unbepreist', () => {
  for (const model of [
    'google/gemini-3.7-flash',
    'google/gemini-3.5-flash',
    'google/gemini-2.5-flash-lite',
    'google/gemini-3.6-flash-lite',
    'google/gemini-3.8-flash-tts',
    'google/gemini-3.1-flash-image',
    'google/gemini-live-3.0-flash',
    'google/gemini-4-argon-preview',
    'google/gemini-9-ultra',
    'google/'
  ]) {
    assert.equal(price(model), null, model)

    const cost = estimateModelUsageCost(model, { promptTokens: 10, completionTokens: 10 }, NOW)

    assert.equal(cost.priced, false, model)
    assert.equal(cost.costUsd, null, model)
  }
})

test('Bestehende Anbieter bleiben unberuehrt', () => {
  assert.equal(price('claude-sonnet-5-5').key, 'anthropic:claude-sonnet-5')
  assert.equal(price('openai/gpt-5.6-luna').key, 'openai:gpt-5.6-luna:2026-07-30')
  assert.equal(price('deepseek/deepseek-v4-flash').key, 'deepseek:v4-flash:2026-07')
  assert.equal(price('glm-5.1:cloud'), null)
  assert.equal(price('qwen3:8b').local, true)
})
