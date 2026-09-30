import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  displayConvoTitle
} from '../client/src/lib/conversationTitle.js'

function read(file) {
  return readFileSync(
    new URL(`../${file}`, import.meta.url),
    'utf8'
  )
}

test('Standardtitel wird deutsch angezeigt, eigene Titel bleiben', () => {
  assert.equal(displayConvoTitle('New Conversation'), 'Neue Unterhaltung')
  assert.equal(displayConvoTitle(''), 'Neue Unterhaltung')
  assert.equal(displayConvoTitle(null), 'Neue Unterhaltung')
  assert.equal(displayConvoTitle('  '), 'Neue Unterhaltung')
  assert.equal(displayConvoTitle('Server Shit'), 'Server Shit')
  assert.equal(displayConvoTitle('  Watchtower '), 'Watchtower')
})

test('mobil: kein Avatar-Streifen und schmalerer Rand im Chat', () => {
  const css = read('client/src/index.css')
  const mobile = css.slice(css.lastIndexOf('/* EchoLink UI polish 1 */'))

  assert.match(mobile, /@media \(max-width: 767px\)/)
  assert.match(mobile, /\.msg-avatar\s*\{\s*display: none !important;/)
  assert.match(mobile, /\.luna-chat-surface\s*\{\s*padding: 16px 12px !important;/)
  assert.match(mobile, /--text1: var\(--text\)/)
})

test('Neu erzeugen sitzt in der Aktionszeile der letzten Antwort', () => {
  const message = read('client/src/components/Message.jsx')
  const chat = read('client/src/pages/Chat.jsx')

  assert.match(message, /retryFailed, onRetry, onRegenerate \}\)/)
  assert.match(message, /onClick=\{onRegenerate\}/)
  assert.match(message, /const RegenIcon = /)

  assert.match(chat, /onRegenerate=\{[\s\S]{0,260}\? regenerate\s*:\s*undefined/)
  assert.match(chat, /m\.id === lastAssistantMsg\?\.id/)
  assert.match(chat, /showRegenerate=\{false\}/)
})

test('Kopfzeile: Status als Punkt mit Zähler, Titel ohne feste Maximalbreite', () => {
  const chat = read('client/src/pages/Chat.jsx')

  assert.match(chat, /function SystemPulse\(/)
  assert.equal(chat.split('<SystemPulse').length - 1, 2)
  assert.doesNotMatch(chat, /maxWidth: 110/)
  assert.doesNotMatch(chat, /left: 'calc\(50% \+ 20px\)'/)
  assert.match(chat, /displayConvoTitle\(activeConvo\.title\)/)
})

test('Systemstatus: ausgeblendete gestoppte Prozesse sind nicht rot', () => {
  const panel = read('client/src/components/SystemStatusPanel.jsx')

  assert.match(
    panel,
    /monitored\s*\?\s*'var\(--danger\)'\s*:\s*'var\(--text3\)'/
  )
  assert.match(panel, /className="echolink-process-row"/)
  assert.match(panel, /caution=\{Number\(status\?\.disk\) >= 80\}/)
  assert.match(panel, /color: status\?\.watchtower\?\.enabled\s*\?\s*'var\(--text2\)'/)
  assert.match(panel, /const digits = absolute < 0\.01 \? 4 : 2/)
})

test('Aufgaben: Jetzt ausführen ist nicht mehr die Hauptaktion', () => {
  const tasks = read('client/src/components/TaskPanel.jsx')

  assert.match(
    tasks,
    /onClick=\{\(\) => runNow\(task\)\}[\s\S]{0,140}style=\{buttonStyle\(\{\s*disabled: busy \|\| activeRun\s*\}\)\}/
  )
  assert.match(tasks, /accent: !task\.enabled,/)
})

test('deutsche Texte statt englischer in Sidebar und Freigabekarte', () => {
  const sidebar = read('client/src/components/Sidebar.jsx')
  const message = read('client/src/components/Message.jsx')
  const chat = read('client/src/pages/Chat.jsx')

  assert.match(sidebar, /displayConvoTitle\(c\.title\)/)
  assert.doesNotMatch(sidebar, /title="New conversation"/)
  assert.doesNotMatch(sidebar, /title="Sign out"/)
  assert.match(message, /Freigabe erforderlich/)
  assert.doesNotMatch(message, /Action requires approval/)
  assert.doesNotMatch(chat, /Select a conversation or create a new one/)
})
