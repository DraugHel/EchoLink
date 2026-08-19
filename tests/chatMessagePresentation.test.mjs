import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const messageSource = fs.readFileSync(
  new URL('../client/src/components/Message.jsx', import.meta.url),
  'utf8'
)
const stylesheet = fs.readFileSync(
  new URL('../client/src/index.css', import.meta.url),
  'utf8'
)

test('chat messages use restrained matte cards and unboxed footer controls', () => {
  assert.match(messageSource, /msg-bubble-user/)
  assert.match(messageSource, /msg-bubble-assistant/)
  assert.match(messageSource, /msg-footer-user/)
  assert.match(messageSource, /msg-footer-assistant/)
  assert.match(messageSource, /msg-actions-user/)
  assert.match(messageSource, /msg-actions-assistant/)
  assert.match(messageSource, /className="msg-avatar"/)
  assert.match(messageSource, /msg-action-danger/)
  assert.match(messageSource, /aria-label="Nachricht löschen"/)
  assert.match(messageSource, /aria-label="Antwort löschen"/)

  assert.match(stylesheet, /\.msg-action-btn\s*\{[^}]*width:\s*30px/s)
  assert.match(stylesheet, /@media \(hover: none\)[\s\S]*width:\s*32px/)
  assert.match(stylesheet, /\.msg-action-btn\.is-copied/)

  const userBubbleStart = stylesheet.indexOf('.msg-bubble-user {')
  const assistantBubbleStart = stylesheet.indexOf('.msg-bubble-assistant {')
  const userBubble = stylesheet.slice(userBubbleStart, assistantBubbleStart)
  const assistantRailStart = stylesheet.indexOf('.msg-bubble-assistant::before {')
  const footerStart = stylesheet.indexOf('.msg-footer {')
  const actionsStart = stylesheet.indexOf('.msg-actions {')
  const actionsEnd = stylesheet.indexOf('.msg-actions-user {')
  const actions = stylesheet.slice(actionsStart, actionsEnd)

  assert.ok(userBubbleStart >= 0)
  assert.ok(assistantBubbleStart > userBubbleStart)
  assert.ok(assistantRailStart > assistantBubbleStart)
  assert.ok(footerStart > assistantRailStart)
  assert.match(userBubble, /border:\s*1px solid color-mix\(/)
  assert.doesNotMatch(userBubble, /border:\s*2px/)
  assert.match(userBubble, /background:\s*color-mix\(in srgb, var\(--bg3\) 90%, var\(--user-bubble\)\)/)
  assert.doesNotMatch(userBubble, /gradient\(/)
  assert.doesNotMatch(userBubble, /backdrop-filter:/)
  assert.doesNotMatch(stylesheet, /\.msg-bubble-user::before\s*\{/)
  assert.match(stylesheet, /\.msg-bubble-assistant\s*\{[^}]*background:\s*var\(--bg3\)/s)
  assert.match(stylesheet, /\.msg-bubble-assistant::before\s*\{[^}]*width:\s*2px/s)
  assert.match(stylesheet, /\.msg-footer-assistant\s*\{[^}]*border-top:/s)
  assert.match(actions, /background:\s*transparent/)
  assert.match(actions, /border:\s*0/)
  assert.doesNotMatch(actions, /border-radius:/)
  assert.match(stylesheet, /\.msg-action-btn\s*\{[^}]*border:\s*0;[^}]*border-radius:\s*7px/s)
})

test('message presentation remains theme-variable driven', () => {
  for (const theme of [
    ':root',
    'html.theme-sakura',
    'html.theme-void',
    'html.theme-blossom',
    'html.theme-tokyo-night'
  ]) {
    assert.match(stylesheet, new RegExp(theme.replace('.', '\\.')))
  }

  const presentationStart = stylesheet.indexOf('.msg-bubble {')
  const presentationEnd = stylesheet.indexOf('.echo-wave')
  const presentation = stylesheet.slice(
    presentationStart,
    presentationEnd
  )

  assert.ok(presentationStart >= 0)
  assert.ok(presentationEnd > presentationStart)
  assert.match(presentation, /var\(--user-bubble\)/)
  assert.match(presentation, /var\(--user-text\)/)
  assert.match(presentation, /var\(--accent\)/)
  assert.match(presentation, /var\(--bg3\)/)
  assert.match(presentation, /var\(--border2\)/)
  assert.doesNotMatch(presentation, /color:\s*#0d0d0d/)
})
