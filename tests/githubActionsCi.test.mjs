import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const workflow = await readFile(
  new URL('../.github/workflows/ci.yml', import.meta.url),
  'utf8'
)
const packageJson = JSON.parse(
  await readFile(
    new URL('../package.json', import.meta.url),
    'utf8'
  )
)

test('GitHub Actions CI läuft für main, Pull Requests und manuell', () => {
  assert.match(workflow, /^name: CI$/m)
  assert.match(workflow, /^  push:$/m)
  assert.match(workflow, /^  pull_request:$/m)
  assert.match(workflow, /^  workflow_dispatch:$/m)
  assert.match(workflow, /branches:\n\s+- main/)
  assert.match(workflow, /cancel-in-progress: true/)
  assert.match(workflow, /timeout-minutes: 20/)
})

test('CI besitzt nur Leserechte und speichert keine Checkout-Credentials', () => {
  assert.match(workflow, /permissions:\n\s+contents: read/)
  assert.match(workflow, /persist-credentials: false/)
  assert.doesNotMatch(workflow, /contents:\s*write/)
  assert.doesNotMatch(workflow, /pull_request_target/)
  assert.doesNotMatch(workflow, /git push|npm run deploy/)
})

test('CI verwendet Node 22, Lockfiles und reproduzierbare Installationen', () => {
  assert.match(workflow, /actions\/checkout@v5/)
  assert.match(workflow, /actions\/setup-node@v6/)
  assert.match(workflow, /node-version: '22'/)
  assert.match(workflow, /cache: npm/)
  assert.match(workflow, /package-lock\.json/)
  assert.match(workflow, /client\/package-lock\.json/)
  assert.match(workflow, /run: npm ci$/m)
  assert.match(workflow, /run: npm ci --prefix client/)
})

test('CI führt Tests, Build und Diff-Prüfung aus', () => {
  assert.equal(
    packageJson.scripts.ci,
    'npm test && npm run build'
  )
  assert.match(workflow, /run: npm run ci/)
  assert.match(workflow, /git diff --check/)
  assert.match(workflow, /git diff-tree --check --root/)
})
