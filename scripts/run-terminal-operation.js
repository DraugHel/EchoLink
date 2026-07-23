import '../server/loadEnv.js'

import {
  executeTerminalOperation,
  getTerminalOperation
} from '../server/lib/terminalOperations.js'

const operationId = String(process.argv[2] || '').trim()

if (!operationId) {
  process.exitCode = 2
} else {
  const operation = getTerminalOperation(operationId)

  if (!operation) {
    process.exitCode = 3
  } else if (operation.status === 'queued') {
    await executeTerminalOperation(operationId)
  }
}
