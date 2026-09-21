import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const registry = fs.readFileSync(
  new URL('../server/lib/toolRegistry.js', import.meta.url),
  'utf8'
)
const chat = fs.readFileSync(
  new URL('../server/routes/chat.js', import.meta.url),
  'utf8'
)

test('Audiobookshelf native tools are registered without terminal wrapping', () => {
  assert.match(registry, /AUDIOBOOKSHELF_TOOLS/)
  assert.match(registry, /audiobookshelfToolsEnabled\(\)/)
  assert.match(chat, /AUDIOBOOKSHELF_WRITE_TOOL_NAMES/)
  assert.match(chat, /pendingAudiobookshelfActions/)
  assert.match(chat, /type: 'audiobookshelf'/)
  assert.match(chat, /prepareAudiobookshelfAction/)
  assert.match(chat, /executeAudiobookshelfTool/)
})

test('native runtime policy forbids curl/terminal for normal ABS work', () => {
  assert.match(
    chat,
    /Use the native audiobookshelf_\* tools; do not use terminal, shell or curl for Audiobookshelf work\./
  )
})

test('legacy Audiobookshelf skill is removed so skill loading cannot trigger terminal cat', () => {
  assert.equal(
    fs.existsSync(
      new URL('../skills/audiobookshelf/SKILL.md', import.meta.url)
    ),
    false
  )
})
