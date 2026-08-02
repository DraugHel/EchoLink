import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  E3ChatSessionService,
  E3_CHAT_PROFILE_IDS,
  E3_CHAT_STATUS,
  e3ChatFeatureEnabled,
  normalizeE3PrepareRequest
} from '../server/e3/chat/chatSessionService.js'
import {
  E3_TOOLS,
  E3_TOOL_NAMES,
  e3ApprovalActionId,
  e3SessionIdFromAction,
  formatE3ApprovalPreview,
  safeE3WorkerEnvironment
} from '../server/lib/e3Tools.js'

const GIT = '/usr/bin/git'

function git(cwd, args) {
  return execFileSync(GIT, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: '/usr/bin:/bin',
      HOME: cwd,
      LANG: 'C',
      LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0'
    }
  }).trim()
}

function createSourceRepository(root) {
  const source = path.join(root, 'source')
  fs.mkdirSync(source)
  git(source, ['init', '--initial-branch=main'])
  git(source, ['config', 'user.name', 'E3 Chat Test'])
  git(source, ['config', 'user.email', 'e3-chat@example.invalid'])
  fs.mkdirSync(path.join(source, 'docs'))
  fs.writeFileSync(path.join(source, 'README.md'), '# EchoLink\n')
  fs.writeFileSync(
    path.join(source, 'docs', 'baseline.txt'),
    'alpha\n'
  )
  git(source, ['add', '--all'])
  git(source, ['commit', '-m', 'baseline'])
  return {
    source,
    baselineCommit: git(source, ['rev-parse', 'HEAD'])
  }
}

function successfulRuntimeFactory(calls) {
  return () => ({
    run(plan) {
      calls.push(plan.profile.id)
      return {
        status: 'succeeded',
        exitCode: 0,
        signal: null,
        stdout: `${plan.profile.id} ok\n`,
        stderr: '',
        outputBytes: 0
      }
    }
  })
}

function serviceHarness(t) {
  const outer = fs.mkdtempSync(
    path.join(os.tmpdir(), 'e3-chat-tools-test-')
  )
  const { source, baselineCommit } =
    createSourceRepository(outer)
  const storageRoot = path.join(outer, 'storage')
  const calls = []
  let clock = 10_000
  const service = new E3ChatSessionService({
    enabled: true,
    storageRoot,
    repositoryRoot: source,
    manifestPath: path.join(outer, 'manifest.json'),
    manifestLoader: () => ({
      sourceHead: baselineCommit,
      manifestSha256: 'c'.repeat(64),
      nodeImageDigest: `sha256:${'a'.repeat(64)}`,
      playwrightImageDigest: `sha256:${'b'.repeat(64)}`
    }),
    runtimeFactory: successfulRuntimeFactory(calls),
    now: () => {
      clock += 1000
      return clock
    },
    requireOriginMain: false
  })
  t.after(() => {
    fs.rmSync(outer, { recursive: true, force: true })
  })
  return {
    calls,
    service,
    source,
    baselineCommit
  }
}

test('E3 chat feature flag is exact and default-off', () => {
  assert.equal(e3ChatFeatureEnabled({}), false)
  assert.equal(e3ChatFeatureEnabled({ E3_CHAT_TOOLS_ENABLED: '1' }), false)
  assert.equal(e3ChatFeatureEnabled({ E3_CHAT_TOOLS_ENABLED: 'TRUE' }), false)
  assert.equal(e3ChatFeatureEnabled({ E3_CHAT_TOOLS_ENABLED: 'true' }), true)
})

test('first Luna bridge admits only exact create and replace operations', () => {
  const request = normalizeE3PrepareRequest({
    userId: 1,
    conversationId: 2,
    requestId: 'request-0001',
    summary: 'Change one fixture',
    operations: [
      {
        type: 'create_file',
        path: 'docs/new.txt',
        content: 'new\n'
      },
      {
        type: 'replace_exact',
        path: 'docs/baseline.txt',
        search: 'alpha',
        replacement: 'omega',
        expectedMatches: 1
      }
    ]
  })
  assert.equal(request.operations.length, 2)
  assert.equal(request.operations[0].type, 'create_file')
  assert.equal(request.operations[1].type, 'replace_exact')

  assert.throws(() => normalizeE3PrepareRequest({
    userId: 1,
    conversationId: 2,
    requestId: 'request-0002',
    summary: 'Traversal',
    operations: [{
      type: 'create_file',
      path: '../escape.txt',
      content: 'blocked\n'
    }]
  }))

  assert.throws(() => normalizeE3PrepareRequest({
    userId: 1,
    conversationId: 2,
    requestId: 'request-0003',
    summary: 'Free command',
    operations: [{
      type: 'shell',
      path: 'docs/a.txt',
      command: 'touch /root/echolink/pwned'
    }]
  }), /not admitted/)
})

test('tool surface has no productive apply, commit, deploy, or shell capability', () => {
  assert.deepEqual(
    [...E3_TOOL_NAMES],
    [
      'e3_prepare_change',
      'e3_get_session',
      'e3_list_sessions',
      'e3_request_approval'
    ]
  )
  const serialized = JSON.stringify(E3_TOOLS).toLowerCase()
  assert.equal(serialized.includes('e3_apply'), false)
  assert.equal(serialized.includes('terminal'), false)
  assert.equal(serialized.includes('pm2'), true)
  assert.equal(serialized.includes('does not apply'), true)
})

test('worker environment drops production secrets and credentials', () => {
  const env = safeE3WorkerEnvironment({
    NODE_ENV: 'production',
    OPENAI_API_KEY: 'secret',
    GITHUB_TOKEN: 'secret',
    DATABASE_URL: 'secret',
    PATH: '/evil'
  })
  assert.deepEqual(Object.keys(env).sort(), [
    'E3_CHAT_TOOLS_ENABLED',
    'HOME',
    'LANG',
    'LC_ALL',
    'NODE_ENV',
    'PATH',
    'TZ'
  ])
  assert.equal(env.PATH, '/usr/bin:/bin')
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(env.GITHUB_TOKEN, undefined)
  assert.equal(env.DATABASE_URL, undefined)
})

test('real E3 services prepare, validate, review, export and clean without touching source', t => {
  const h = serviceHarness(t)
  const sourceHeadBefore = git(h.source, ['rev-parse', 'HEAD'])
  const sourceStatusBefore = git(h.source, [
    'status',
    '--porcelain',
    '--untracked-files=all'
  ])

  const prepareRequest = {
    userId: 1,
    conversationId: 7,
    requestId: 'chat-request-0001',
    summary: 'Create and replace through E3',
    operations: [
      {
        type: 'create_file',
        path: 'docs/from-luna.txt',
        content: 'created by isolated E3\n'
      },
      {
        type: 'replace_exact',
        path: 'docs/baseline.txt',
        search: 'alpha',
        replacement: 'omega',
        expectedMatches: 1
      }
    ]
  }
  const prepared = h.service.prepareChange(prepareRequest)
  const replayedPrepare = h.service.prepareChange(prepareRequest)

  assert.equal(replayedPrepare.sessionId, prepared.sessionId)
  assert.equal(replayedPrepare.replayed, true)
  assert.equal(replayedPrepare.actionRequired, true)
  assert.equal(prepared.status, E3_CHAT_STATUS.READY_FOR_REVIEW)
  assert.equal(prepared.actionRequired, true)
  assert.equal(prepared.operationCount, 2)
  assert.equal(prepared.diff.sha256, prepared.candidate.forwardPatchSha256)
  assert.equal(prepared.validation.profiles.length, E3_CHAT_PROFILE_IDS.length)
  assert.deepEqual(h.calls, [...E3_CHAT_PROFILE_IDS])
  assert.equal(
    prepared.validation.profiles.every(profile =>
      profile.status === 'succeeded'
    ),
    true
  )
  assert.equal(
    fs.existsSync(path.join(h.source, 'docs', 'from-luna.txt')),
    false
  )
  assert.equal(
    fs.readFileSync(path.join(h.source, 'docs', 'baseline.txt'), 'utf8'),
    'alpha\n'
  )

  const approved = h.service.approveChange({
    sessionId: prepared.sessionId,
    userId: 1
  })
  assert.equal(approved.status, E3_CHAT_STATUS.COMPLETED)
  assert.match(approved.export.packageSha256, /^[0-9a-f]{64}$/)
  assert.equal(approved.export.sessionState, 'COMPLETED')
  assert.equal(approved.export.cleanup.removed, true)
  const replayedApproval = h.service.approveChange({
    sessionId: prepared.sessionId,
    userId: 1
  })
  assert.equal(replayedApproval.replayed, true)
  assert.equal(
    replayedApproval.export.packageSha256,
    approved.export.packageSha256
  )
  assert.equal(
    approved.export.downloadUrl,
    `/api/chat/e3/session/${prepared.sessionId}/export`
  )

  const exported = h.service.readExport({
    sessionId: prepared.sessionId,
    userId: 1
  })
  assert.equal(exported.sha256, approved.export.packageSha256)
  assert.equal(exported.bytes.length, approved.export.bytes)

  assert.equal(git(h.source, ['rev-parse', 'HEAD']), sourceHeadBefore)
  assert.equal(git(h.source, [
    'status',
    '--porcelain',
    '--untracked-files=all'
  ]), sourceStatusBefore)
})

test('prepare request replay is byte-bound across reconnects', t => {
  const h = serviceHarness(t)
  h.service.prepareChange({
    userId: 3,
    conversationId: 9,
    requestId: 'chat-request-replay-0001',
    summary: 'Byte-bound prepare',
    operations: [{
      type: 'create_file',
      path: 'docs/replay.txt',
      content: 'first\n'
    }]
  })
  assert.throws(() => h.service.prepareChange({
    userId: 3,
    conversationId: 9,
    requestId: 'chat-request-replay-0001',
    summary: 'Byte-bound prepare',
    operations: [{
      type: 'create_file',
      path: 'docs/replay.txt',
      content: 'different\n'
    }]
  }), error => error?.code === 'E3_CHAT_STATE_CONFLICT')
})

test('denial is durable, cleans the workspace, and creates no export', t => {
  const h = serviceHarness(t)
  const prepared = h.service.prepareChange({
    userId: 2,
    conversationId: 8,
    requestId: 'chat-request-0002',
    summary: 'Deny this change',
    operations: [{
      type: 'create_file',
      path: 'docs/denied.txt',
      content: 'denied\n'
    }]
  })
  const denied = h.service.denyChange({
    sessionId: prepared.sessionId,
    userId: 2
  })
  assert.equal(denied.status, E3_CHAT_STATUS.DENIED)
  assert.equal(denied.export, null)
  assert.equal(denied.failure.code, 'DENIED_BY_USER')
  assert.equal(denied.failure.cleanup.removed, true)
  const replayedDenial = h.service.denyChange({
    sessionId: prepared.sessionId,
    userId: 2
  })
  assert.equal(replayedDenial.replayed, true)
  assert.throws(() => h.service.readExport({
    sessionId: prepared.sessionId,
    userId: 2
  }), /not available/)
})

test('action IDs are namespaced and approval preview states the non-apply boundary', () => {
  const sessionId = '123e4567-e89b-42d3-a456-426614174000'
  const actionId = e3ApprovalActionId(sessionId)
  assert.equal(actionId, `e3-${sessionId}`)
  assert.equal(e3SessionIdFromAction(actionId), sessionId)
  assert.equal(e3SessionIdFromAction(sessionId), null)
  const preview = formatE3ApprovalPreview({
    sessionId,
    summary: 'Preview',
    baselineCommit: 'a'.repeat(40),
    operationPaths: ['docs/a.txt'],
    validation: {
      profiles: E3_CHAT_PROFILE_IDS.map(profileId => ({
        profileId,
        status: 'succeeded'
      }))
    },
    diff: {
      sha256: 'b'.repeat(64),
      preview: 'diff --git a/docs/a.txt b/docs/a.txt\n',
      truncated: false
    }
  })
  assert.match(preview, /Approve creates a verified export package only/)
  assert.match(preview, /does not apply, commit, push, deploy, or restart PM2/)
})

test('chat wiring is gated, authenticated, and uses the existing Approve/Deny UI', () => {
  const registry = fs.readFileSync(
    new URL('../server/lib/toolRegistry.js', import.meta.url),
    'utf8'
  )
  const chat = fs.readFileSync(
    new URL('../server/routes/chat.js', import.meta.url),
    'utf8'
  )
  assert.equal(registry.includes("from './e3Tools.js'"), true)
  assert.equal(registry.includes('e3ToolsEnabled() ? E3_TOOLS : []'), true)
  assert.equal(chat.includes('pendingE3Actions'), true)
  assert.equal(chat.includes('E3_TOOL_NAMES.has(name)'), true)
  assert.equal(chat.includes("type: 'e3'"), true)
  assert.equal(chat.includes("'/e3/session/:sessionId/export'"), true)
  assert.equal(chat.includes('approveE3Action'), true)
  assert.equal(chat.includes('denyE3Action'), true)
  assert.equal(chat.includes('E3 never applies, commits, pushes, deploys, or restarts PM2'), true)
})
