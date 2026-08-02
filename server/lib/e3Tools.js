import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import process from 'node:process'
import {
  E3_CHAT_FEATURE_FLAG,
  E3_CHAT_ERROR,
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
        'Approval creates a verified export package only and does not apply the change; this first bridge never writes to the productive repository, commits, pushes, deploys, or restarts PM2. ' +
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

export function approveE3Action(
  sessionId,
  userId,
  options = {}
) {
  return runE3Worker(
    'approve',
    { sessionId, userId },
    options
  )
}

export function denyE3Action(
  sessionId,
  userId,
  options = {}
) {
  return runE3Worker(
    'deny',
    { sessionId, userId },
    options
  )
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

export function e3ApprovalActionId(sessionId) {
  return `e3-${sessionId}`
}

export function e3SessionIdFromAction(actionId) {
  const value = String(actionId || '')
  if (!value.startsWith('e3-')) return null
  const sessionId = value.slice(3)
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(sessionId)
    ? sessionId
    : null
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
    'Approve creates a verified export package only. It does not apply, commit, push, deploy, or restart PM2.'
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
      'The productive repository was not modified.'
    )
  } else if (result.status === 'READY_FOR_REVIEW') {
    lines.push(
      'The validated diff is waiting for the application Approve/Deny card. Approval exports the patch but does not apply it.'
    )
  }
  return lines.join('\n')
}
