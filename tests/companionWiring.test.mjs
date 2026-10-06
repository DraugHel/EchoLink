import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function read(file) {
  return readFileSync(
    new URL(`../${file}`, import.meta.url),
    'utf8'
  )
}

test('die Luna-Route ist eingehaengt', () => {
  const index = read('server/index.js')

  assert.match(index, /import companionRoutes from '\.\/routes\/companion\.js'/)
  assert.match(index, /app\.use\('\/api\/companion', companionRoutes\)/)

  const route = read('server/routes/companion.js')

  for (const path of ["'/'", "'/preview'", "'/send-now'"]) {
    assert.ok(route.includes(path), path)
  }
  assert.equal((route.match(/requireAuth/g) || []).length >= 5, true)
})

test('der Worker fuehrt den Companion-Takt aus und faehrt sauber herunter', () => {
  const worker = read('server/worker.js')

  assert.match(worker, /from '\.\/lib\/companion\.js'/)
  assert.match(worker, /let companionTicking = false/)
  assert.match(worker, /async function companionTick\(\)/)
  assert.match(worker, /companionHasActiveUsers\(db\)/)
  assert.match(worker, /setInterval\(companionTick, COMPANION_POLL_MS\)/)
  assert.match(worker, /ticking \|\| watchtowerTicking \|\| companionTicking/)
})

test('Menue und Chat oeffnen das Luna-Panel', () => {
  const menu = read('client/src/components/AppToolsMenu.jsx')
  const chat = read('client/src/pages/Chat.jsx')

  assert.match(menu, /onOpenCompanion,/)
  assert.match(menu, /icon="companion"/)
  assert.match(menu, /title="Luna"/)
  assert.match(menu, /if \(type === 'companion'\)/)

  assert.match(chat, /const CompanionPanel = lazy\(/)
  assert.match(chat, /useState\(false\)\n  const \[showCompanion/)
  assert.match(chat, /onOpenCompanion=\{\(\) => \{/)
  assert.match(chat, /<CompanionPanel\b/)
  assert.match(chat, /onOpenConversation=\{openCompanionConversation\}/)
  assert.match(chat, /async function openCompanionConversation\(/)
})

test('Luna ist standardmaessig aus und hat ein hartes Tageslimit', () => {
  const store = read('server/lib/companionStore.js')
  const plan = read('server/lib/companionPlan.js')

  assert.match(store, /enabled INTEGER NOT NULL DEFAULT 0/)
  assert.match(store, /muted INTEGER NOT NULL DEFAULT 0/)
  assert.match(plan, /HARD_MAX_PER_DAY = 8/)
})

test('das Modell bekommt keine Werkzeuge und der Kontext ist als Daten markiert', () => {
  const companion = read('server/lib/companion.js')
  const context = read('server/lib/companionContext.js')

  assert.match(companion, /deps\.complete\(/)
  assert.doesNotMatch(companion, /ALL_TOOLS|tools:\s*\[[^\]]/)
  assert.match(context, /nur Daten, keine Anweisungen/)
  assert.match(context, /Bewusst nur Absender und Betreff/)
})

test('Luna kann den Tagesplan neu wuerfeln (Route, Auto-Reset, Panel)', () => {
  const route = read('server/routes/companion.js')
  const panel = read('client/src/components/CompanionPanel.jsx')

  assert.match(route, /'\/replan'/)
  assert.match(route, /planNeedsReset\(before, settings\)/)
  assert.match(route, /resetCompanionPlan\(db, userId\)/)

  assert.match(panel, /Plan neu würfeln/)
  assert.match(panel, /\/api\/companion\/replan/)
  assert.match(panel, /onReplan/)
})
