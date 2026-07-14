import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

test('Memory-Modul hat gültige Syntax', () => {
  const result = spawnSync(
    process.execPath,
    ['--check', 'server/lib/memoryItems.js'],
    { encoding: 'utf8' }
  )

  assert.equal(
    result.status,
    0,
    result.stderr || result.stdout
  )
})
