import process from 'node:process'
import {
  E3ChatSessionService,
  E3_CHAT_ERROR
} from './chatSessionService.js'

const MAX_INPUT_BYTES = 2 * 1024 * 1024
const COMMANDS = new Set([
  'prepare',
  'get',
  'list',
  'review',
  'approve',
  'deny'
])

async function readInput() {
  const chunks = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    bytes += chunk.length
    if (bytes > MAX_INPUT_BYTES) {
      throw Object.assign(
        new Error('E3 worker input exceeds the fixed byte limit'),
        { code: E3_CHAT_ERROR.INVALID_REQUEST }
      )
    }
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function resultFor(service, command, input) {
  switch (command) {
    case 'prepare':
      return service.prepareChange(input)
    case 'get':
      return service.getSession(input)
    case 'list':
      return service.listSessions(input)
    case 'review':
      return service.requestApproval(input)
    case 'approve':
      return service.approveChange(input)
    case 'deny':
      return service.denyChange(input)
    default:
      throw Object.assign(
        new Error('Unknown E3 worker command'),
        { code: E3_CHAT_ERROR.INVALID_REQUEST }
      )
  }
}

async function main() {
  const command = process.argv[2]
  if (process.argv.length !== 3 || !COMMANDS.has(command)) {
    throw Object.assign(
      new Error('usage: chatWorker.mjs prepare|get|list|review|approve|deny'),
      { code: E3_CHAT_ERROR.INVALID_REQUEST }
    )
  }
  const input = await readInput()
  const service = new E3ChatSessionService({ enabled: true })
  const result = await resultFor(service, command, input)
  process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`)
}

main().catch(error => {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: {
      name: error?.name || 'Error',
      code: error?.code || E3_CHAT_ERROR.INTERNAL,
      message: String(error?.message || error).slice(0, 4000),
      details: error?.details || {}
    }
  })}\n`)
  process.exitCode = 1
})
