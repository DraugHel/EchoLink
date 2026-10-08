import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  matchesSearch,
  normalizeSearchText,
  searchTerms
} from '../client/src/lib/memorySearch.js'

const LABELS = { fact: 'Fakt', preference: 'Präferenz', project: 'Projekt' }

const items = [
  { id: 12, type: 'fact', scope: 'global', content: 'Claude Haiku 5.5 ist am 7. Oktober 2026 erschienen.', metadata: { autoSaved: true, source: 'https://www.anthropic.com/news' } },
  { id: 13, type: 'preference', scope: 'global', content: 'Antwortet gern kurz und auf Österreichisch.', metadata: {} },
  { id: 14, type: 'project', scope: 'project:echolink', content: 'EchoLink nutzt Brave Search mit SearXNG als Fallback.' },
  { id: 15, type: 'fact', scope: 'global', content: 'Der Server steht in Nürnberg.' }
]

function search(query) {
  const terms = searchTerms(query)

  return items.filter(item => matchesSearch(item, terms, LABELS)).map(item => item.id)
}

test('Text wird vereinheitlicht: Gross/Klein, Umlaute, Akzente', () => {
  assert.equal(normalizeSearchText('Österreichisch'), 'oesterreichisch')
  assert.equal(normalizeSearchText('Nürnberg Straße'), 'nuernberg strasse')
  assert.equal(normalizeSearchText('Café'), 'cafe')
  assert.equal(normalizeSearchText(null), '')
  assert.deepEqual(searchTerms('  Haiku   5.5 '), ['haiku', '5.5'])
  assert.deepEqual(searchTerms(''), [])
  assert.deepEqual(searchTerms(null), [])
})

test('leere Suche zeigt alles', () => {
  assert.deepEqual(search(''), [12, 13, 14, 15])
  assert.deepEqual(search('   '), [12, 13, 14, 15])
})

test('ein oder mehrere Woerter: alle muessen vorkommen', () => {
  assert.deepEqual(search('haiku'), [12])
  assert.deepEqual(search('HAIKU erschienen'), [12])
  assert.deepEqual(search('haiku nuernberg'), [])
  assert.deepEqual(search('brave searxng'), [14])
  assert.deepEqual(search('server'), [15])
})

test('Umlaute und ae/oe/ue sind austauschbar', () => {
  assert.deepEqual(search('nürnberg'), [15])
  assert.deepEqual(search('nuernberg'), [15])
  assert.deepEqual(search('österreichisch'), [13])
  assert.deepEqual(search('oesterreichisch'), [13])
})

test('Typ (auch deutsch), Scope und ID sind durchsuchbar', () => {
  assert.deepEqual(search('präferenz'), [13])
  assert.deepEqual(search('praeferenz'), [13])
  assert.deepEqual(search('fakt'), [12, 15])
  assert.deepEqual(search('project:echolink'), [14])
  assert.deepEqual(search('id:12'), [12])
  assert.deepEqual(search('#14'), [14])
})

test('die Quelle automatisch gespeicherter Eintraege ist durchsuchbar', () => {
  assert.deepEqual(search('anthropic.com'), [12])
})

test('fehlende Felder machen nichts kaputt', () => {
  assert.equal(matchesSearch({ id: 1 }, ['x']), false)
  assert.equal(matchesSearch({ id: 1, content: 'abc' }, ['abc']), true)
  assert.equal(matchesSearch({ id: 1, content: 'abc' }, []), true)
})

test('das Memory-Panel nutzt die Suche', () => {
  const panel = readFileSync(
    new URL('../client/src/components/MemoryPanel.jsx', import.meta.url),
    'utf8'
  )

  assert.match(panel, /from '\.\.\/lib\/memorySearch\.js'/)
  assert.match(panel, /matchesSearch\(item, terms, TYPE_LABELS\)/)
  assert.match(panel, /placeholder="Memories durchsuchen …"/)
  assert.match(panel, /\[items, itemSort, itemSearch\]/)
  assert.match(panel, /Keine Treffer für diese Suche\./)
  assert.match(panel, /ID: \{item\.id\}/)
  assert.match(panel, /Zusammengeführt aus ID/)
  assert.match(panel, /Von Luna gespeichert/)
})
