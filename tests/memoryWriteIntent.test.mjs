import assert from 'node:assert/strict'
import test from 'node:test'

import {
  shouldForceMemoryUpdate
} from '../server/lib/memoryWriteIntent.js'

test('explicit German remember requests trigger immediate extraction', () => {
  const positives = [
    'merk dir bitte, dass ich Markus heiße',
    'merk die bitte fass ich markus heiße',
    'merke dir: ich mag kurze Antworten',
    'merk bitte dass ich Kaffee schwarz trinke',
    'Bitte merk dir das.',
    'bitte merken: mein Name ist Markus',
    'kannst du dir merken, dass ich Markus heiße?',
    'kannste dir bitte merken dass ich Markus heiße',
    'speichere das bitte für später',
    'speicher dir bitte, dass ich Fedora nutze',
    'bitte speichern: ich nutze Fedora',
    'behalte dir bitte, dass ich Markus heiße',
    'könntest du dir das bitte behalten?',
    'ab jetzt bitte auf Deutsch antworten',
    'von nun an nenn mich Markus',
    'ich bevorzuge kurze Antworten',
    'please remember that my name is Markus',
    'remember this: my name is Markus',
    'save this for later'
  ]

  for (const input of positives) {
    assert.equal(
      shouldForceMemoryUpdate(input),
      true,
      `expected immediate memory extraction for: ${input}`
    )
  }
})

test('explicit forget requests trigger immediate extraction', () => {
  const positives = [
    'vergiss bitte, dass ich Kaffee mag',
    'bitte vergiss das',
    'das bitte nicht mehr merken',
    'das bitte nicht mehr speichern',
    'aus der memory entfernen',
    'aus den erinnerungen löschen',
    'please forget that'
  ]

  for (const input of positives) {
    assert.equal(
      shouldForceMemoryUpdate(input),
      true,
      `expected immediate memory extraction for: ${input}`
    )
  }
})

test('ordinary observations do not spuriously trigger memory extraction', () => {
  const negatives = [
    'ich merke, dass der Cache funktioniert',
    'man merkt den Unterschied sofort',
    'der Speicher ist fast voll',
    'ich kann mir das nie merken',
    'kannst du das bitte prüfen?',
    'das ist bemerkenswert',
    'heute bin ich müde',
    ''
  ]

  for (const input of negatives) {
    assert.equal(
      shouldForceMemoryUpdate(input),
      false,
      `did not expect forced memory extraction for: ${input}`
    )
  }
})
