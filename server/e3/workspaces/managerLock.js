import {
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import {
  E3_WORKSPACE_ERROR,
  E3WorkspaceError
} from './errors.js'

function workspaceError(code, message, details = {}, cause) {
  throw new E3WorkspaceError(
    code,
    message,
    details,
    cause ? { cause } : {}
  )
}

export function acquireManagerLock(lockPath, {
  owner,
  acquiredAt
}) {
  let descriptor
  try {
    descriptor = openSync(lockPath, 'wx', 0o600)
    writeFileSync(
      descriptor,
      `${JSON.stringify({ owner, acquiredAt })}\n`,
      { encoding: 'utf8' }
    )
    fsyncSync(descriptor)
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    if (error?.code === 'EEXIST') {
      workspaceError(
        E3_WORKSPACE_ERROR.LOCKED,
        'Manager resource is already locked'
      )
    }
    workspaceError(
      E3_WORKSPACE_ERROR.LOCK_TAMPERED,
      'Manager lock could not be acquired',
      {},
      error
    )
  }

  const identity = fstatSync(descriptor)
  let released = false

  return Object.freeze({
    release() {
      if (released) return
      let current
      try {
        current = lstatSync(lockPath)
      } catch (error) {
        closeSync(descriptor)
        released = true
        workspaceError(
          E3_WORKSPACE_ERROR.LOCK_TAMPERED,
          'Manager lock disappeared before release',
          {},
          error
        )
      }
      if (
        current.dev !== identity.dev ||
        current.ino !== identity.ino ||
        current.isSymbolicLink()
      ) {
        closeSync(descriptor)
        released = true
        workspaceError(
          E3_WORKSPACE_ERROR.LOCK_TAMPERED,
          'Manager lock identity changed before release'
        )
      }
      closeSync(descriptor)
      unlinkSync(lockPath)
      released = true
    }
  })
}
