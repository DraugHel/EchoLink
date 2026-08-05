import {
  createHash,
  createHmac,
  timingSafeEqual
} from 'node:crypto'
import { spawn } from 'node:child_process'
import process from 'node:process'
import {
  E3_CHAT_FEATURE_FLAG,
  E3_CHAT_ERROR,
  E3_CHAT_STATUS,
  e3ChatFeatureEnabled
} from '../e3/chat/chatSessionService.js'

const WORKER_PATH =
  '/root/echolink/server/e3/chat/chatWorker.mjs'
const WORKER_CWD = '/root/echolink'
const MAX_WORKER_OUTPUT_BYTES = 4 * 1024 * 1024
const WORKER_TIMEOUT_MS = 45 * 60 * 1000

export const E3_TOOL = Object.freeze({
  PREPARE_CHANGE: 'e3_prepare_change',
  GET_SESSION: 'e3_get_session',
  LIST_SESSIONS: 'e3_list_sessions',
  REQUEST_APPROVAL: 'e3_request_approval'
})

export const E3_TOOL_NAMES = new Set(
  Object.values(E3_TOOL)
)

const OPERATION_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: {
          type: 'string',
          enum: ['create_file']
        },
        path: {
          type: 'string',
          description:
            'Repository-relative UTF-8 text path. Absolute paths, traversal, secrets, databases, .git and other protected targets are rejected.'
        },
        content: {
          type: 'string',
          description: 'Complete UTF-8 content for the new file.'
        }
      },
      required: ['type', 'path', 'content']
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: {
          type: 'string',
          enum: ['replace_exact']
        },
        path: {
          type: 'string',
          description: 'Repository-relative UTF-8 text path.'
        },
        search: {
          type: 'string',
          description:
            'Exact text that must occur the declared number of times.'
        },
        replacement: {
          type: 'string',
          description: 'Exact replacement text.'
        },
        expectedMatches: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description:
            'Exact number of required matches. Usually 1.'
        }
      },
      required: [
        'type',
        'path',
        'search',
        'replacement',
        'expectedMatches'
      ]
    }
  ]
}

export const E3_TOOLS = Object.freeze([
  {
    type: 'function',
    function: {
      name: E3_TOOL.PREPARE_CHANGE,
      description:
        'Prepare a requested EchoLink source change through E3. ' +
        'Use only when the user explicitly asks to modify EchoLink code or repository files. ' +
        'Inspect the relevant source first with read-only tools, then submit a small exact operation list. ' +
        'E3 creates an isolated workspace, records preimages, freezes a deterministic candidate, runs all eight required validation profiles, and presents the exact diff for application approval. ' +
        'Approval creates a verified export package and authorizes you to continue the requested change yourself through the terminal tool: verify every binding, apply only that export, check, commit, push, deploy, and perform final verification. ' +
        'Do not ask for natural-language confirmation before calling this tool because the application presents its own Approve/Deny card after successful validation.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: {
            type: 'string',
            description:
              'Short description of the requested source change.'
          },
          operations: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            items: OPERATION_SCHEMA,
            description:
              'Ordered create_file and replace_exact operations.'
          }
        },
        required: ['summary', 'operations']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: E3_TOOL.GET_SESSION,
      description:
        'Read the durable status, hashes, validation result, diff preview and export information for one E3 session owned by the current user.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: {
            type: 'string',
            description: 'Canonical E3 session UUID.'
          }
        },
        required: ['sessionId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: E3_TOOL.LIST_SESSIONS,
      description:
        'List recent E3 sessions owned by the current user. By default only sessions from this conversation are returned.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          allConversations: {
            type: 'boolean',
            description:
              'Set true only when the user asks for E3 sessions across all conversations.'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: E3_TOOL.REQUEST_APPROVAL,
      description:
        'Re-display the application approval card for an existing review-ready E3 session in this conversation. Use after a reconnect or when the user explicitly asks to continue that session.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: {
            type: 'string',
            description: 'Canonical E3 session UUID.'
          }
        },
        required: ['sessionId']
      }
    }
  }
])

export function e3ToolsEnabled(env = process.env) {
  return e3ChatFeatureEnabled(env)
}

export function safeE3WorkerEnvironment(
  env = process.env
) {
  return Object.freeze({
    PATH: '/usr/bin:/bin',
    HOME: '/var/lib/echolink-e3',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TZ: 'UTC',
    NODE_ENV: env.NODE_ENV === 'production'
      ? 'production'
      : 'test',
    [E3_CHAT_FEATURE_FLAG]: 'true'
  })
}

function workerError(payload, stderr, exitCode) {
  const message =
    payload?.error?.message ||
    stderr.trim().slice(0, 2000) ||
    `E3 worker exited with code ${exitCode}`
  const error = new Error(message)
  error.name = payload?.error?.name || 'E3WorkerError'
  error.code = payload?.error?.code || E3_CHAT_ERROR.INTERNAL
  error.details = payload?.error?.details || {}
  return error
}

export function runE3Worker(
  command,
  input,
  {
    spawnFn = spawn,
    timeoutMs = WORKER_TIMEOUT_MS,
    env = process.env
  } = {}
) {
  return new Promise((resolve, reject) => {
    const child = spawnFn(
      process.execPath,
      [WORKER_PATH, command],
      {
        cwd: WORKER_CWD,
        env: safeE3WorkerEnvironment(env),
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe']
      }
    )
    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = callback => value => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      callback(value)
    }
    const succeed = finish(resolve)
    const fail = finish(reject)

    const timeout = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {}
      setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {}
      }, 5000).unref?.()
      const error = new Error(
        'E3 worker exceeded its fixed execution window'
      )
      error.code = 'E3_CHAT_WORKER_TIMEOUT'
      fail(error)
    }, timeoutMs)
    timeout.unref?.()

    const append = (current, chunk) => {
      const next = current + chunk.toString('utf8')
      if (Buffer.byteLength(next, 'utf8') > MAX_WORKER_OUTPUT_BYTES) {
        try {
          process.kill(-child.pid, 'SIGTERM')
        } catch {}
        const error = new Error(
          'E3 worker exceeded its fixed output budget'
        )
        error.code = 'E3_CHAT_WORKER_OUTPUT_LIMIT'
        fail(error)
      }
      return next
    }

    child.stdin.once('error', fail)
    child.stdout.on('data', chunk => {
      stdout = append(stdout, chunk)
    })
    child.stderr.on('data', chunk => {
      stderr = append(stderr, chunk)
    })
    child.once('error', fail)
    child.once('close', exitCode => {
      if (settled) return
      const lines = stdout
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
      let payload
      try {
        payload = JSON.parse(lines.at(-1) || '{}')
      } catch {
        fail(workerError(null, stderr, exitCode))
        return
      }
      if (exitCode !== 0 || payload.ok !== true) {
        fail(workerError(payload, stderr, exitCode))
        return
      }
      succeed(payload.result)
    })

    try {
      child.stdin.end(JSON.stringify(input))
    } catch (error) {
      fail(error)
    }
  })
}

function canonicalToolJson(value) {
  const canonical = item => {
    if (Array.isArray(item)) return item.map(canonical)
    if (item && typeof item === 'object') {
      return Object.fromEntries(
        Object.keys(item).sort().map(key => [key, canonical(item[key])])
      )
    }
    return item
  }
  return JSON.stringify(canonical(value))
}

function prepareToolRequestId(requestId, args) {
  const digest = createHash('sha256')
    .update(canonicalToolJson({
      summary: args?.summary,
      operations: args?.operations
    }))
    .digest('hex')
    .slice(0, 32)
  return `e3:${requestId}:${digest}`
}

function requestEnvelope(context) {
  const userId = Number(context?.userId)
  const conversationId = Number(context?.conversationId)
  if (
    !Number.isSafeInteger(userId) ||
    userId <= 0 ||
    !Number.isSafeInteger(conversationId) ||
    conversationId <= 0
  ) {
    const error = new Error('E3 tool context is invalid')
    error.code = E3_CHAT_ERROR.INVALID_REQUEST
    throw error
  }
  const requestId = String(context?.requestId || '').trim()
  if (
    requestId.length < 8 ||
    requestId.length > 120 ||
    !/^[A-Za-z0-9._:-]+$/.test(requestId)
  ) {
    const error = new Error('E3 chat request ID is invalid')
    error.code = E3_CHAT_ERROR.INVALID_REQUEST
    throw error
  }
  return {
    userId,
    conversationId,
    requestId
  }
}

export async function executeE3Tool(
  name,
  args,
  context,
  options = {}
) {
  if (!e3ToolsEnabled()) {
    const error = new Error('E3 chat tools are disabled')
    error.code = E3_CHAT_ERROR.DISABLED
    throw error
  }
  const envelope = requestEnvelope(context)
  if (name === E3_TOOL.PREPARE_CHANGE) {
    return runE3Worker(
      'prepare',
      {
        ...envelope,
        requestId: prepareToolRequestId(
          envelope.requestId,
          args
        ),
        summary: args?.summary,
        operations: args?.operations
      },
      options
    )
  }
  if (name === E3_TOOL.GET_SESSION) {
    return runE3Worker(
      'get',
      {
        sessionId: args?.sessionId,
        userId: envelope.userId
      },
      options
    )
  }
  if (name === E3_TOOL.LIST_SESSIONS) {
    return runE3Worker(
      'list',
      {
        userId: envelope.userId,
        conversationId: args?.allConversations === true
          ? null
          : envelope.conversationId
      },
      options
    )
  }
  if (name === E3_TOOL.REQUEST_APPROVAL) {
    return runE3Worker(
      'review',
      {
        sessionId: args?.sessionId,
        userId: envelope.userId,
        conversationId: envelope.conversationId
      },
      options
    )
  }
  const error = new Error(`Unknown E3 tool: ${name}`)
  error.code = E3_CHAT_ERROR.INVALID_REQUEST
  throw error
}

const E3_ACTION_PATTERN =
  /^e3-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-([0-9a-f]{64})-([0-9a-f]{64})$/

function approvalCardSecret(secret = process.env.SESSION_SECRET) {
  const value = String(secret || '')
  if (
    value.length < 16 ||
    value === 'aender-mich' ||
    value === 'echolink-change-this-secret'
  ) {
    const error = new Error(
      'E3 approval cards require the configured session secret'
    )
    error.code = E3_CHAT_ERROR.INTERNAL
    throw error
  }
  return value
}

export function e3ApprovalBindingSha256(result) {
  const binding = {
    version: 1,
    sessionId: result?.sessionId,
    conversationId: result?.conversationId,
    baselineCommit: result?.baselineCommit,
    candidateSetId: result?.candidate?.id,
    candidateManifestSha256:
      result?.candidate?.candidateManifestSha256,
    forwardPatchSha256:
      result?.candidate?.forwardPatchSha256,
    reviewSetId: result?.review?.id,
    validationManifestSha256:
      result?.review?.validationManifestSha256,
    reviewSummarySha256:
      result?.review?.reviewSummarySha256,
    diffSha256: result?.diff?.sha256
  }
  return createHash('sha256')
    .update(canonicalToolJson(binding))
    .digest('hex')
}

function e3ApprovalCapability(
  sessionId,
  bindingSha256,
  secret
) {
  return createHmac(
    'sha256',
    approvalCardSecret(secret)
  )
    .update(
      `echolink-e3-approval-card-v1\0` +
      `${sessionId}\0${bindingSha256}`
    )
    .digest('hex')
}

export function e3ApprovalActionId(
  result,
  secret = process.env.SESSION_SECRET
) {
  const sessionId = String(result?.sessionId || '')
  const bindingSha256 =
    e3ApprovalBindingSha256(result)
  const capability = e3ApprovalCapability(
    sessionId,
    bindingSha256,
    secret
  )
  return `e3-${sessionId}-${bindingSha256}-${capability}`
}

export function parseE3ApprovalActionId(actionId) {
  const match = E3_ACTION_PATTERN.exec(
    String(actionId || '')
  )
  if (!match) return null
  return Object.freeze({
    sessionId: match[1],
    bindingSha256: match[2],
    capability: match[3]
  })
}

export function e3SessionIdFromAction(actionId) {
  return parseE3ApprovalActionId(actionId)?.sessionId || null
}

export function verifyE3ApprovalActionId(
  actionId,
  result,
  secret = process.env.SESSION_SECRET
) {
  const parsed = parseE3ApprovalActionId(actionId)
  if (
    !parsed ||
    parsed.sessionId !== result?.sessionId
  ) {
    return false
  }
  let expected
  try {
    expected = e3ApprovalActionId(result, secret)
  } catch {
    return false
  }
  const suppliedBytes = Buffer.from(
    String(actionId),
    'utf8'
  )
  const expectedBytes = Buffer.from(expected, 'utf8')
  return (
    suppliedBytes.length === expectedBytes.length &&
    timingSafeEqual(suppliedBytes, expectedBytes)
  )
}

async function authorizeE3ApprovalAction(
  actionId,
  userId,
  acceptedStatuses,
  options
) {
  const parsed = parseE3ApprovalActionId(actionId)
  if (!parsed) {
    const error = new Error(
      'E3 approval card capability is invalid'
    )
    error.code = E3_CHAT_ERROR.INVALID_REQUEST
    throw error
  }
  const result = await runE3Worker(
    'get',
    {
      sessionId: parsed.sessionId,
      userId
    },
    options
  )
  if (!acceptedStatuses.includes(result?.status)) {
    const error = new Error(
      'E3 approval card is stale for the current session state'
    )
    error.code = E3_CHAT_ERROR.STATE_CONFLICT
    throw error
  }
  if (!verifyE3ApprovalActionId(actionId, result)) {
    const error = new Error(
      'E3 approval card does not match the durable reviewed bytes'
    )
    error.code = E3_CHAT_ERROR.FORBIDDEN
    throw error
  }
  return Object.freeze({
    sessionId: parsed.sessionId,
    result
  })
}

export async function approveE3Action(
  actionId,
  userId,
  options = {}
) {
  const authorized = await authorizeE3ApprovalAction(
    actionId,
    userId,
    [
      E3_CHAT_STATUS.READY_FOR_REVIEW,
      E3_CHAT_STATUS.COMPLETED
    ],
    options
  )
  return runE3Worker(
    'approve',
    {
      sessionId: authorized.sessionId,
      userId
    },
    options
  )
}

export async function denyE3Action(
  actionId,
  userId,
  options = {}
) {
  const authorized = await authorizeE3ApprovalAction(
    actionId,
    userId,
    [
      E3_CHAT_STATUS.READY_FOR_REVIEW,
      E3_CHAT_STATUS.DENIED
    ],
    options
  )
  return runE3Worker(
    'deny',
    {
      sessionId: authorized.sessionId,
      userId
    },
    options
  )
}

export async function listE3PendingApprovals(
  userId,
  conversationId,
  options = {}
) {
  const sessions = await runE3Worker(
    'list',
    {
      userId,
      conversationId
    },
    options
  )
  return Object.freeze(
    sessions.filter(
      session =>
        session?.status ===
        E3_CHAT_STATUS.READY_FOR_REVIEW
    )
  )
}

export function e3ApprovalActionRequest(
  result,
  {
    secret = process.env.SESSION_SECRET,
    restored = false
  } = {}
) {
  if (
    result?.status !== E3_CHAT_STATUS.READY_FOR_REVIEW ||
    !result?.review ||
    !result?.diff
  ) {
    const error = new Error(
      'E3 approval card requires durable review-ready bytes'
    )
    error.code = E3_CHAT_ERROR.STATE_CONFLICT
    throw error
  }
  return Object.freeze({
    actionRequest: true,
    actionId: e3ApprovalActionId(result, secret),
    description:
      `E3 validated ${result.operationCount} exact source operation${
        result.operationCount === 1 ? '' : 's'
      } and froze the reviewed bytes.`,
    command: formatE3ApprovalPreview(result),
    reason:
      'Approve creates the verified E3 export package and authorizes Luna to apply, commit, push, deploy and verify it herself through the terminal.',
    type: 'e3',
    source: 'chat',
    ...(restored ? { restored: true } : {})
  })
}

export async function readE3ExportPackage(
  sessionId,
  userId
) {
  const {
    E3ChatSessionService
  } = await import(
    '../e3/chat/chatSessionService.js'
  )
  return new E3ChatSessionService({
    enabled: e3ToolsEnabled()
  }).readExport({ sessionId, userId })
}

export function formatE3ApprovalPreview(result) {
  const profileLines = (result.validation?.profiles || [])
    .map(profile => `- ${profile.profileId}: ${profile.status}`)
    .join('\n')
  const paths = (result.operationPaths || [])
    .map(path => `- ${path}`)
    .join('\n')
  const preview = result.diff?.preview || '(no diff preview available)'
  return [
    `E3 session: ${result.sessionId}`,
    `Summary: ${result.summary}`,
    `Base: ${result.baselineCommit}`,
    '',
    'Paths:',
    paths,
    '',
    'Validation:',
    profileLines,
    '',
    `Patch SHA-256: ${result.diff?.sha256 || 'unknown'}`,
    '',
    'Diff preview:',
    preview,
    result.diff?.truncated
      ? '\n[preview truncated; the approval remains bound to the full patch hash]'
      : '',
    '',
    'Approve creates the verified export package and authorizes Luna to continue herself through the terminal: verify all bindings, apply only this export, check, commit, push, deploy and finally verify. No architect handoff or second confirmation is required.'
  ].filter(value => value !== '').join('\n')
}

export function formatE3ToolResult(result) {
  if (Array.isArray(result)) {
    if (result.length === 0) return 'No E3 sessions found.'
    return result.map(item => [
      `${item.sessionId} · ${item.status}`,
      item.summary,
      `base ${item.baselineCommit}`,
      item.export?.downloadUrl
        ? `export ${item.export.downloadUrl}`
        : null
    ].filter(Boolean).join(' · ')).join('\n')
  }
  if (!result || typeof result !== 'object') {
    return String(result || '')
  }
  const lines = [
    `E3 session ${result.sessionId}`,
    `Status: ${result.status}`,
    `Summary: ${result.summary}`,
    `Base commit: ${result.baselineCommit}`
  ]
  if (result.validation?.profiles) {
    lines.push(
      'Validation: ' +
      result.validation.profiles
        .map(profile => `${profile.profileId}=${profile.status}`)
        .join(', ')
    )
  }
  if (result.failure) {
    lines.push(
      `Failure: ${result.failure.code}: ${result.failure.message}`
    )
  }
  if (result.export) {
    lines.push(
      `Export SHA-256: ${result.export.packageSha256}`,
      `Download: ${result.export.downloadUrl}`,
      'The productive repository has not been modified yet.',
      'Continue now through the terminal tool: verify the exact session, export, approval, base and candidate bindings; apply only this export; check; commit; push; deploy; and perform final verification. Do not hand off to an architect and do not ask for another confirmation.'
    )
  } else if (result.status === 'READY_FOR_REVIEW') {
    lines.push(
      'The validated diff is waiting for the application Approve/Deny card. Approval authorizes Luna to export it and then finish the exact change herself through the terminal.'
    )
  }
  return lines.join('\n')
}
