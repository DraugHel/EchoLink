import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  E3EditorKernel,
  editorFeatureEnabled
} from '../server/e3/editor/editorKernel.js'
import {
  E3_EDITOR_API_VERSION,
  E3_EDITOR_OPERATION
} from '../server/e3/editor/contracts.js'
import { E3_EDITOR_ERROR } from '../server/e3/editor/errors.js'
import { sha256 } from '../server/e3/editor/safeTextFilesystem.js'

const V = E3_EDITOR_API_VERSION

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e3-editor-'))
  fs.mkdirSync(path.join(root, 'src'))
  fs.mkdirSync(path.join(root, 'other'))
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'alpha\nbeta\nalpha\n')
  fs.writeFileSync(path.join(root, 'src', 'b.txt'), 'needle\n')
  const retained = []
  const kernel = new E3EditorKernel({
    workspaceRoot: root,
    enabled: true,
    forbiddenRoots: ['/root/echolink'],
    retainPreimage: preimage => {
      retained.push(preimage)
      return `sha256:${preimage.sha256}`
    },
    ...options
  })
  return {
    root,
    retained,
    kernel,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  }
}

function request(type, fields = {}) {
  return { version: V, type, ...fields }
}

function code(expected) {
  return error => error?.code === expected
}

test('editor feature and kernel are fail-closed', () => {
  assert.equal(editorFeatureEnabled({}), false)
  assert.equal(editorFeatureEnabled({ ECHOLINK_E3_EDITOR_ENABLED: '1' }), false)
  assert.equal(editorFeatureEnabled({ ECHOLINK_E3_EDITOR_ENABLED: 'true' }), true)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e3-disabled-'))
  assert.throws(() => new E3EditorKernel({ workspaceRoot: root }),
    code(E3_EDITOR_ERROR.INVALID_REQUEST))
  assert.throws(() => new E3EditorKernel({
    workspaceRoot: '/root/echolink',
    enabled: true
  }), code(E3_EDITOR_ERROR.FORBIDDEN_PATH))
  fs.rmSync(root, { recursive: true })
})

test('read, stat, list and search are deterministic and do not follow symlinks', t => {
  const f = fixture()
  t.after(f.cleanup)
  fs.symlinkSync('/etc/passwd', path.join(f.root, 'src', 'link'))
  const read = f.kernel.execute(request(E3_EDITOR_OPERATION.READ_FILE, {
    path: 'src/a.js'
  }))
  assert.equal(read.result.content, 'alpha\nbeta\nalpha\n')
  assert.equal(read.result.sha256, sha256(Buffer.from(read.result.content)))
  assert.deepEqual(
    f.kernel.execute(request(E3_EDITOR_OPERATION.LIST_FILES, {
      path: 'src'
    })).result.map(item => [item.name, item.kind]),
    [['a.js', 'file'], ['b.txt', 'file'], ['link', 'symlink']]
  )
  assert.equal(f.kernel.execute(request(E3_EDITOR_OPERATION.STAT_FILE, {
    path: 'src/link'
  })).result.kind, 'symlink')
  assert.throws(() => f.kernel.execute(request(E3_EDITOR_OPERATION.READ_FILE, {
    path: 'src/link'
  })), code(E3_EDITOR_ERROR.SYMLINK_BLOCKED))
  assert.deepEqual(
    f.kernel.execute(request(E3_EDITOR_OPERATION.SEARCH_TEXT, {
      query: 'alpha'
    })).result.map(item => item.path),
    ['src/a.js', 'src/a.js']
  )
})

test('request and path policy reject ambiguity across operations', t => {
  const f = fixture()
  t.after(f.cleanup)
  const invalid = [
    '../x', '/tmp/x', 'src//x', 'src/x/', 'src\\x',
    'src/é.js', '.git/config', 'data/x', 'src/node_modules/x',
    '.env', 'src/cache.db'
  ]
  for (const candidate of invalid) {
    assert.throws(() => f.kernel.execute(request(
      E3_EDITOR_OPERATION.CREATE_FILE,
      { path: candidate, content: 'x' }
    )), error => [
      E3_EDITOR_ERROR.INVALID_PATH,
      E3_EDITOR_ERROR.FORBIDDEN_PATH
    ].includes(error?.code), candidate)
  }
  assert.throws(() => f.kernel.execute({
    version: V,
    type: E3_EDITOR_OPERATION.READ_FILE,
    path: 'src/a.js',
    surprise: true
  }), code(E3_EDITOR_ERROR.INVALID_REQUEST))
  assert.throws(() => f.kernel.execute({
    version: 999,
    type: E3_EDITOR_OPERATION.READ_FILE,
    path: 'src/a.js'
  }), code(E3_EDITOR_ERROR.UNSUPPORTED_VERSION))
})

test('create, replace and inserts are exact, atomic and retain preimages', t => {
  const f = fixture()
  t.after(f.cleanup)
  f.kernel.execute(request(E3_EDITOR_OPERATION.CREATE_FILE, {
    path: 'src/new.txt',
    content: 'new'
  }))
  assert.equal(fs.readFileSync(path.join(f.root, 'src/new.txt'), 'utf8'), 'new')
  assert.throws(() => f.kernel.execute(request(E3_EDITOR_OPERATION.CREATE_FILE, {
    path: 'src/new.txt',
    content: 'again'
  })), code(E3_EDITOR_ERROR.FILE_EXISTS))

  const original = fs.readFileSync(path.join(f.root, 'src/a.js'))
  assert.throws(() => f.kernel.execute(request(E3_EDITOR_OPERATION.REPLACE_EXACT, {
    path: 'src/a.js',
    expectedSha256: sha256(original),
    search: 'alpha',
    replacement: 'omega'
  })), code(E3_EDITOR_ERROR.MATCH_COUNT_MISMATCH))
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'src/a.js')), original)

  f.kernel.execute(request(E3_EDITOR_OPERATION.REPLACE_EXACT, {
    path: 'src/a.js',
    expectedSha256: sha256(original),
    search: 'alpha',
    replacement: 'omega',
    expectedMatches: 2
  }))
  assert.equal(fs.readFileSync(path.join(f.root, 'src/a.js'), 'utf8'),
    'omega\nbeta\nomega\n')
  assert.equal(f.retained.length, 1)
  assert.deepEqual(f.retained[0].content, original)

  let current = fs.readFileSync(path.join(f.root, 'src/b.txt'))
  f.kernel.execute(request(E3_EDITOR_OPERATION.INSERT_BEFORE, {
    path: 'src/b.txt',
    expectedSha256: sha256(current),
    anchor: 'needle',
    content: 'before-'
  }))
  current = fs.readFileSync(path.join(f.root, 'src/b.txt'))
  f.kernel.execute(request(E3_EDITOR_OPERATION.INSERT_AFTER, {
    path: 'src/b.txt',
    expectedSha256: sha256(current),
    anchor: 'needle',
    content: '-after'
  }))
  assert.equal(fs.readFileSync(path.join(f.root, 'src/b.txt'), 'utf8'),
    'before-needle-after\n')
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'src'))
    .filter(name => name.startsWith('.e3-stage-')), [])
})

test('preimage mismatch, hardlinks and parent symlinks cannot mutate outside', t => {
  const f = fixture()
  t.after(f.cleanup)
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'e3-outside-'))
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
  fs.writeFileSync(path.join(outside, 'canary'), 'safe')
  fs.symlinkSync(outside, path.join(f.root, 'escape'))
  assert.throws(() => f.kernel.execute(request(E3_EDITOR_OPERATION.CREATE_FILE, {
    path: 'escape/owned',
    content: 'bad'
  })), code(E3_EDITOR_ERROR.SYMLINK_BLOCKED))
  assert.equal(fs.existsSync(path.join(outside, 'owned')), false)

  fs.linkSync(path.join(outside, 'canary'), path.join(f.root, 'src', 'hard'))
  assert.throws(() => f.kernel.execute(request(E3_EDITOR_OPERATION.DELETE_FILE, {
    path: 'src/hard',
    expectedSha256: sha256(Buffer.from('safe'))
  })), code(E3_EDITOR_ERROR.HARDLINK_BLOCKED))
  assert.equal(fs.readFileSync(path.join(outside, 'canary'), 'utf8'), 'safe')

  assert.throws(() => f.kernel.execute(request(E3_EDITOR_OPERATION.DELETE_FILE, {
    path: 'src/a.js',
    expectedSha256: '0'.repeat(64)
  })), code(E3_EDITOR_ERROR.PREIMAGE_MISMATCH))
  assert.equal(fs.existsSync(path.join(f.root, 'src', 'a.js')), true)
})

test('lease rejection and injected failure publish nothing and remove owned stage', t => {
  let calls = 0
  const f = fixture({
    assertLease: () => {
      calls += 1
      if (calls === 2) throw new Error('lost')
    }
  })
  t.after(f.cleanup)
  f.kernel.execute(request(E3_EDITOR_OPERATION.CREATE_FILE, {
    path: 'src/one.txt',
    content: 'one'
  }))
  assert.equal(fs.existsSync(path.join(f.root, 'src', 'one.txt')), true)
  assert.throws(() => f.kernel.execute(request(E3_EDITOR_OPERATION.CREATE_FILE, {
    path: 'src/two.txt',
    content: 'two'
  })), code(E3_EDITOR_ERROR.LEASE_REJECTED))
  assert.equal(fs.existsSync(path.join(f.root, 'src', 'two.txt')), false)
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'src'))
    .filter(name => name.startsWith('.e3-stage-')), [])
})

test('rename, move and delete enforce semantics and preserve undo material', t => {
  const f = fixture()
  t.after(f.cleanup)
  const digest = sha256(fs.readFileSync(path.join(f.root, 'src/a.js')))
  assert.throws(() => f.kernel.execute(request(E3_EDITOR_OPERATION.MOVE_FILE, {
    sourcePath: 'src/a.js',
    destinationPath: 'src/c.js',
    expectedSha256: digest
  })), code(E3_EDITOR_ERROR.MOVE_SEMANTICS_MISMATCH))
  f.kernel.execute(request(E3_EDITOR_OPERATION.RENAME_FILE, {
    sourcePath: 'src/a.js',
    destinationPath: 'src/c.js',
    expectedSha256: digest
  }))
  f.kernel.execute(request(E3_EDITOR_OPERATION.MOVE_FILE, {
    sourcePath: 'src/c.js',
    destinationPath: 'other/c.js',
    expectedSha256: digest
  }))
  f.kernel.execute(request(E3_EDITOR_OPERATION.DELETE_FILE, {
    path: 'other/c.js',
    expectedSha256: digest
  }))
  assert.equal(fs.existsSync(path.join(f.root, 'other/c.js')), false)
  assert.equal(f.retained.length, 3)
  assert.equal(f.retained.every(item => item.sha256 === digest), true)
})

test('retention failure is fail-closed', t => {
  const f = fixture({
    retainPreimage: () => { throw new Error('storage unavailable') }
  })
  t.after(f.cleanup)
  const digest = sha256(fs.readFileSync(path.join(f.root, 'src/a.js')))
  assert.throws(() => f.kernel.execute(request(E3_EDITOR_OPERATION.DELETE_FILE, {
    path: 'src/a.js',
    expectedSha256: digest
  })), code(E3_EDITOR_ERROR.PREIMAGE_RETENTION_FAILED))
  assert.equal(fs.existsSync(path.join(f.root, 'src/a.js')), true)
})
