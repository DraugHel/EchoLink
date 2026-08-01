import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  DEPENDENCY_ROOT,
  DRIVER_PROFILE,
  INPUT_ROOT,
  OUTPUT_ROOT,
  TEMP_ROOT,
  UI_FIXTURE_ROOT,
  WORK_ROOT,
  childEnvironment
} from './contracts.mjs'
import { runNode } from './safeProcess.mjs'
import {
  copyValidationWorkspace,
  listFiles
} from './safeTree.mjs'

const JAVASCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs'])
const TEXT_EXTENSIONS = new Set([
  '.cjs', '.css', '.html', '.js', '.json', '.jsx', '.md', '.mjs',
  '.sh', '.sql', '.svg', '.txt', '.yml', '.yaml'
])

function prepareWorkspace() {
  return copyValidationWorkspace({
    inputRoot: INPUT_ROOT,
    workRoot: WORK_ROOT,
    dependencyRoot: DEPENDENCY_ROOT
  })
}

function textFiles(root) {
  return listFiles(root, file => TEXT_EXTENSIONS.has(path.extname(file)))
}

function assertTextHygiene(root) {
  const errors = []
  for (const file of textFiles(root)) {
    const relative = path.relative(root, file).split(path.sep).join('/')
    const bytes = fs.readFileSync(file)
    if (bytes.includes(0)) continue
    const text = bytes.toString('utf8')
    const lines = text.split('\n')
    lines.forEach((line, index) => {
      const clean = line.endsWith('\r') ? line.slice(0, -1) : line
      if (/[ \t]+$/.test(clean)) {
        errors.push(`${relative}:${index + 1}: trailing whitespace`)
      }
      if (/^(<{7}|={7}|>{7})( |$)/.test(clean)) {
        errors.push(`${relative}:${index + 1}: conflict marker`)
      }
    })
  }
  if (errors.length > 0) {
    throw new Error(errors.slice(0, 200).join('\n'))
  }
}

function javascriptFiles(root) {
  return listFiles(root, file =>
    JAVASCRIPT_EXTENSIONS.has(path.extname(file))
  )
}

function jsonFiles(root) {
  return listFiles(root, file => path.extname(file) === '.json')
}

function runDiffCheck(context) {
  const workspace = prepareWorkspace()
  assertTextHygiene(workspace.workRoot)
  process.stdout.write('E3_DRIVER_DIFF_CHECK_OK\n')
}

function runJavascriptSyntax(context) {
  const workspace = prepareWorkspace()
  const env = childEnvironment()
  for (const file of javascriptFiles(workspace.workRoot)) {
    runNode(['--check', file], {
      cwd: workspace.workRoot,
      env
    })
  }
  process.stdout.write('E3_DRIVER_JAVASCRIPT_SYNTAX_OK\n')
}

function runJsonSyntax(context) {
  const workspace = prepareWorkspace()
  for (const file of jsonFiles(workspace.workRoot)) {
    try {
      JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (cause) {
      throw new Error(
        `Invalid JSON: ${path.relative(workspace.workRoot, file)}`,
        { cause }
      )
    }
  }
  process.stdout.write('E3_DRIVER_JSON_SYNTAX_OK\n')
}

function testFiles(root, targeted) {
  const testsRoot = path.join(root, 'tests')
  if (!fs.existsSync(testsRoot)) {
    throw new Error('Validation snapshot has no tests directory')
  }
  return fs.readdirSync(testsRoot)
    .filter(name => name.endsWith('.test.mjs'))
    .filter(name => !targeted || name.startsWith('e3'))
    .sort()
    .map(name => path.join(testsRoot, name))
}

function runTests(context, targeted) {
  const workspace = prepareWorkspace()
  const files = testFiles(workspace.workRoot, targeted)
  if (files.length === 0) {
    throw new Error('Validation profile resolved no test files')
  }
  runNode(['--test', ...files], {
    cwd: workspace.workRoot,
    env: childEnvironment(),
    maxBuffer: 10 * 1024 * 1024
  })
  process.stdout.write(
    targeted
      ? 'E3_DRIVER_TARGETED_TESTS_OK\n'
      : 'E3_DRIVER_FULL_TESTS_OK\n'
  )
}

function runFrontendBuild(context) {
  const workspace = prepareWorkspace()
  const vite = path.join(
    DEPENDENCY_ROOT,
    'client/node_modules/vite/bin/vite.js'
  )
  if (!fs.statSync(vite).isFile()) {
    throw new Error('Trusted Vite executable is unavailable')
  }

  const clientRoot = path.join(workspace.workRoot, 'client')
  const clientMode = fs.statSync(clientRoot).mode & 0o777

  fs.chmodSync(clientRoot, clientMode | 0o700)
  try {
    runNode([vite, 'build'], {
      cwd: clientRoot,
      env: childEnvironment(),
      maxBuffer: 10 * 1024 * 1024
    })
  } finally {
    fs.chmodSync(clientRoot, clientMode)
  }

  const index = path.join(workspace.workRoot, 'dist/index.html')
  if (!fs.statSync(index).isFile() || fs.statSync(index).size === 0) {
    throw new Error('Frontend build did not produce dist/index.html')
  }
  process.stdout.write('E3_DRIVER_FRONTEND_BUILD_OK\n')
}

async function runSqliteIntegrity(context) {
  const workspace = prepareWorkspace()
  const databaseModule = await import(pathToFileURL(path.join(
    workspace.workRoot,
    'server/e3/persistence/database.js'
  )))
  const databasePath = path.join(TEMP_ROOT, 'sqlite/editor.db')
  const database = databaseModule.openEditorDatabase({ databasePath })
  try {
    databaseModule.verifyEditorDatabase(database)
    const quickCheck = database.pragma('quick_check', { simple: true })
    if (quickCheck !== 'ok') {
      throw new Error('Synthetic SQLite quick_check failed')
    }
  } finally {
    database.close()
  }
  process.stdout.write('E3_DRIVER_SQLITE_INTEGRITY_OK\n')
}

function contentType(file) {
  const extension = path.extname(file)
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml'
  }[extension] ?? 'application/octet-stream'
}

function fixturePath(root, requestUrl) {
  const rawPath = String(requestUrl ?? '/').split(/[?#]/, 1)[0]
  let pathname
  try {
    pathname = decodeURIComponent(rawPath)
  } catch {
    return null
  }
  if (
    !pathname.startsWith('/') ||
    pathname.includes('\0') ||
    pathname.includes('\\')
  ) {
    return null
  }
  const segments = pathname.split('/')
  if (segments.some(segment => segment === '.' || segment === '..')) {
    return null
  }
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1)
  const resolved = path.resolve(root, relative)
  if (
    resolved !== root &&
    !resolved.startsWith(`${root}${path.sep}`)
  ) {
    return null
  }
  return resolved
}

async function runUiApplication(context) {
  const workspace = prepareWorkspace()
  const root = path.join(workspace.workRoot, UI_FIXTURE_ROOT)
  if (!fs.statSync(path.join(root, 'index.html')).isFile()) {
    throw new Error('UI validation fixture is unavailable')
  }
  const server = http.createServer((request, response) => {
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405)
      response.end()
      return
    }
    const target = fixturePath(root, request.url ?? '/')
    if (!target || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
      response.writeHead(404)
      response.end()
      return
    }
    const bytes = fs.readFileSync(target)
    response.writeHead(200, {
      'content-type': contentType(target),
      'content-length': String(bytes.length),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    })
    if (request.method === 'HEAD') response.end()
    else response.end(bytes)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(4173, '0.0.0.0', resolve)
  })
  process.stdout.write('E3_DRIVER_UI_APPLICATION_READY\n')
  const stop = signal => {
    server.close(() => process.exit(signal === 'SIGTERM' ? 0 : 1))
  }
  process.once('SIGTERM', () => stop('SIGTERM'))
  process.once('SIGINT', () => stop('SIGINT'))
  await new Promise(() => {})
}

async function runPlaywrightUi(context) {
  const expectedPath = path.join(
    INPUT_ROOT,
    UI_FIXTURE_ROOT,
    'expected.json'
  )
  const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'))
  if (
    Object.keys(expected).sort().join(',') !== 'marker,title' ||
    typeof expected.title !== 'string' ||
    typeof expected.marker !== 'string'
  ) {
    throw new Error('UI validation expectation is invalid')
  }
  const { chromium } = await import('playwright-core')
  const browser = await chromium.launch({
    headless: true,
    chromiumSandbox: false,
    args: ['--disable-dev-shm-usage']
  })
  const failures = []
  try {
    const browserContext = await browser.newContext({
      acceptDownloads: false,
      serviceWorkers: 'block'
    })
    const page = await browserContext.newPage()
    page.on('console', message => {
      if (message.type() === 'error') {
        failures.push(`console: ${message.text()}`)
      }
    })
    page.on('pageerror', error => {
      failures.push(`pageerror: ${error.message}`)
    })
    page.on('requestfailed', request => {
      failures.push(`request: ${request.url()}`)
    })
    await page.route('**/*', async route => {
      const requestUrl = new URL(route.request().url())
      const allowed = new URL(context.testOrigin)
      if (
        requestUrl.protocol === allowed.protocol &&
        requestUrl.hostname === allowed.hostname &&
        requestUrl.port === allowed.port
      ) {
        await route.continue()
      } else {
        failures.push(`blocked: ${requestUrl.href}`)
        await route.abort('blockedbyclient')
      }
    })
    let response
    let lastError
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        response = await page.goto(context.testOrigin, {
          waitUntil: 'networkidle',
          timeout: 2_000
        })
        if (response) break
      } catch (error) {
        lastError = error
        await new Promise(resolve => setTimeout(resolve, 500))
      }
    }
    if (!response) throw lastError ?? new Error('UI application unavailable')
    if (!response.ok()) {
      throw new Error(`UI application returned HTTP ${response.status()}`)
    }
    await page.waitForSelector(
      `[data-e3-validation="${expected.marker}"]`,
      { timeout: 10_000 }
    )
    if (await page.title() !== expected.title) {
      throw new Error('UI validation title does not match')
    }
    if (failures.length > 0) {
      throw new Error(failures.slice(0, 100).join('\n'))
    }
    fs.mkdirSync(OUTPUT_ROOT, { recursive: true })
    await page.screenshot({
      path: path.join(OUTPUT_ROOT, 'e3-validation.png'),
      fullPage: true
    })
    fs.writeFileSync(
      path.join(OUTPUT_ROOT, 'e3-validation-result.json'),
      `${JSON.stringify({
        title: expected.title,
        marker: expected.marker,
        origin: context.testOrigin
      }, null, 2)}\n`,
      { mode: 0o600 }
    )
    await browserContext.close()
  } finally {
    await browser.close()
  }
  process.stdout.write('E3_DRIVER_PLAYWRIGHT_UI_OK\n')
}

const HANDLERS = Object.freeze({
  [DRIVER_PROFILE.DIFF_CHECK]: runDiffCheck,
  [DRIVER_PROFILE.SYNTAX_JAVASCRIPT]: runJavascriptSyntax,
  [DRIVER_PROFILE.SYNTAX_JSON]: runJsonSyntax,
  [DRIVER_PROFILE.TEST_TARGETED]: context => runTests(context, true),
  [DRIVER_PROFILE.TEST_FULL]: context => runTests(context, false),
  [DRIVER_PROFILE.BUILD_FRONTEND]: runFrontendBuild,
  [DRIVER_PROFILE.SQLITE_INTEGRITY]: runSqliteIntegrity,
  [DRIVER_PROFILE.PLAYWRIGHT_UI]: runPlaywrightUi,
  [DRIVER_PROFILE.PLAYWRIGHT_APPLICATION]: runUiApplication
})

export async function runValidationProfile(context) {
  const handler = HANDLERS[context.profileId]
  if (!handler) throw new Error('Validation driver profile has no handler')
  await handler(context)
}

export {
  assertTextHygiene,
  fixturePath
}
