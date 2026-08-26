import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)

const read = relativePath =>
  fs.readFileSync(path.join(root, relativePath), 'utf8')

function jsxFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .flatMap(entry => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) return jsxFiles(full)
      return entry.isFile() && entry.name.endsWith('.jsx')
        ? [full]
        : []
    })
}

test('shared EchoLink mark follows the active theme accent', () => {
  const source = read('client/src/components/EchoLinkMark.jsx')

  assert.match(source, /color:\s*'var\(--accent\)'/)
  assert.match(source, /stroke="currentColor"/)
  assert.doesNotMatch(source, /#2ecc71|#00e676|#0d0d0d/i)
})

test('all visible brand surfaces use the shared EchoLink mark', () => {
  const login = read('client/src/pages/Login.jsx')
  const sidebar = read('client/src/components/Sidebar.jsx')
  const message = read('client/src/components/Message.jsx')
  const chat = read('client/src/pages/Chat.jsx')

  assert.match(login, /<EchoLinkMark size=\{32\} title="EchoLink" \/>/)
  assert.match(sidebar, /<EchoLinkMark size=\{22\} title="EchoLink" \/>/)
  assert.match(message, /<EchoLinkMark size=\{18\} \/>/)
  assert.match(chat, /<EchoLinkMark size=\{48\} title="EchoLink" \/>/)
})

test('legacy stock-chart mark is gone from the React UI', () => {
  const legacyPath = 'M8 22 L14 10 L20 18 L24 14'
  const sourceRoot = path.join(root, 'client/src')
  const offenders = jsxFiles(sourceRoot)
    .filter(file => fs.readFileSync(file, 'utf8').includes(legacyPath))
    .map(file => path.relative(root, file))

  assert.deepEqual(offenders, [])
})

test('theme accent values remain distinct so the mark can adapt', () => {
  const css = read('client/src/index.css')

  assert.match(css, /:root\s*\{[\s\S]*?--accent:\s*#2ecc71/)
  assert.match(css, /html\.theme-sakura\s*\{[\s\S]*?--accent:\s*#f9a8d4/)
  assert.match(css, /html\.theme-void\s*\{[\s\S]*?--accent:\s*#a78bfa/)
  assert.match(css, /html\.theme-blossom\s*\{[\s\S]*?--accent:\s*#c2185b/)
  assert.match(css, /html\.theme-tokyo-night\s*\{[\s\S]*?--accent:\s*#7aa2f7/)
})
