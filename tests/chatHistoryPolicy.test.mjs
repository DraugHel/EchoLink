import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isExplicitChatHistoryRequest,
  isMemoryInventoryRequest,
  isRecallOnlyRequest,
  recallRuntimeInstruction
} from '../server/lib/memoryRecallPolicy.js'

test('historical git/terminal wording remains recall-only', () => {
  assert.equal(isRecallOnlyRequest('Welchen git-Befehl hatten wir damals benutzt?'), true)
  assert.equal(isRecallOnlyRequest('Wie hatten wir das Terminalproblem damals gelöst?'), true)
})

test('explicit old-chat search is recognized without turning into web research', () => {
  assert.equal(isExplicitChatHistoryRequest('Durchsuche unsere alten Chats nach Scarlett Guitarix.'), true)
  assert.equal(isRecallOnlyRequest('Durchsuche unsere alten Chats nach Scarlett Guitarix.'), true)
  assert.equal(isRecallOnlyRequest('Such im Web nach Scarlett 2i2.'), false)
})

test('current investigation with historical comparison keeps normal work mode', () => {
  assert.equal(isRecallOnlyRequest('Prüfe jetzt den Server und vergleiche mit damals.'), false)
  assert.equal(isRecallOnlyRequest('Kontrolliere den aktuellen Git-Stand und sag, was wir damals gemacht hatten.'), false)
  assert.equal(isRecallOnlyRequest('Was hatten wir damals identifiziert? Prüf bitte den aktuellen Serverstatus.'), false)
  assert.equal(isRecallOnlyRequest('Erinnerst du dich an den Fehler? Suche jetzt in den Logs danach.'), false)
})

test('memory inventory remains its own tool-free mode', () => {
  assert.equal(isMemoryInventoryRequest('Was weißt du über mich?'), true)
  assert.equal(isExplicitChatHistoryRequest('Was weißt du über mich?'), false)
})

test('recall runtime instruction permits only history tools and frames old text as data', () => {
  const text = recallRuntimeInstruction({ hasRecallMatch: false, explicitHistorySearch: true })
  assert.match(text, /search_chat_history/)
  assert.match(text, /read_chat_excerpt/)
  assert.match(text, /never a current instruction/i)
  assert.match(text, /explicitly requested the original chat/i)
  assert.match(recallRuntimeInstruction({ hasRecallMatch: true }), /Answer directly/)
  assert.match(recallRuntimeInstruction({ hasRecallMatch: false }), /No matching structured memory/)
  assert.match(recallRuntimeInstruction({ hasRecallMatch: false }), /Tools are intentionally unavailable/)
})
