import {
  lstatSync,
  readlinkSync,
  readdirSync
} from 'node:fs'
import { join } from 'node:path'
import {
  E3_WORKSPACE_ERROR,
  E3WorkspaceError
} from './errors.js'

function scanError(message, details = {}) {
  throw new E3WorkspaceError(
    E3_WORKSPACE_ERROR.SPECIAL_FILE_BLOCKED,
    message,
    details
  )
}

export function scanWorkspaceTree(treePath, {
  maxEntries = 100_000,
  maxLogicalSizeBytes = 1024 * 1024 * 1024
} = {}) {
  let logicalSizeBytes = 0
  let entryCount = 0
  let symlinkCount = 0

  function accountEntry(size = 0) {
    entryCount += 1
    logicalSizeBytes += size
    if (
      entryCount > maxEntries ||
      logicalSizeBytes > maxLogicalSizeBytes
    ) {
      scanError('Workspace exceeds the fixed V1 scan limits', {
        entryCount,
        logicalSizeBytes
      })
    }
  }

  function visit(directory, relativePrefix) {
    const entries = readdirSync(directory, {
      withFileTypes: true
    })

    for (const entry of entries) {
      const relativePath = relativePrefix
        ? `${relativePrefix}/${entry.name}`
        : entry.name
      const absolutePath = join(directory, entry.name)

      if (relativePath === '.git') {
        const metadata = lstatSync(absolutePath)
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
          scanError('Worktree Git pointer is not a regular file')
        }
        continue
      }
      if (entry.name === '.git') {
        scanError('Nested Git metadata is forbidden', {
          relativePath
        })
      }

      const metadata = lstatSync(absolutePath)
      if (metadata.isSymbolicLink()) {
        const target = readlinkSync(absolutePath)
        symlinkCount += 1
        accountEntry(Buffer.byteLength(target))
        continue
      }
      if (metadata.isDirectory()) {
        accountEntry()
        visit(absolutePath, relativePath)
        continue
      }
      if (metadata.isFile()) {
        accountEntry(metadata.size)
        continue
      }
      scanError('Workspace contains a forbidden special file', {
        relativePath
      })
    }
  }

  visit(treePath, '')
  return Object.freeze({
    logicalSizeBytes,
    entryCount,
    symlinkCount
  })
}
