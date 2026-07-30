import path from 'node:path'
import {
  E3_EDITOR_API_VERSION,
  E3_EDITOR_MUTATIONS,
  E3_EDITOR_OPERATION,
  E3_PATH_POLICY_VERSION
} from './contracts.js'
import { E3_EDITOR_ERROR, E3EditorError } from './errors.js'
import { validateEditorRequest } from './requestSchema.js'
import { SafeTextFilesystem, sha256 } from './safeTextFilesystem.js'

export const E3_EDITOR_FEATURE_ENV = 'ECHOLINK_E3_EDITOR_ENABLED'

export function editorFeatureEnabled(env = process.env) {
  return env[E3_EDITOR_FEATURE_ENV] === 'true'
}

function countOccurrences(text, needle) {
  let count = 0
  let offset = 0
  while ((offset = text.indexOf(needle, offset)) !== -1) {
    count += 1
    offset += needle.length
  }
  return count
}

function assertMatches(actual, expected) {
  if (actual !== expected) {
    throw new E3EditorError(
      E3_EDITOR_ERROR.MATCH_COUNT_MISMATCH,
      'Exact match count differs from request',
      { actual, expected }
    )
  }
}

function editedContent(request, current) {
  const needle = request.search ?? request.anchor
  assertMatches(
    countOccurrences(current.content, needle),
    request.expectedMatches
  )
  const replacement = request.type === E3_EDITOR_OPERATION.REPLACE_EXACT
    ? request.replacement
    : request.type === E3_EDITOR_OPERATION.INSERT_BEFORE
      ? `${request.content}${request.anchor}`
      : `${request.anchor}${request.content}`
  return current.content.split(needle).join(replacement)
}

export class E3EditorKernel {
  constructor({
    workspaceRoot,
    enabled = false,
    forbiddenRoots = ['/root/echolink'],
    ...filesystemOptions
  }) {
    if (!enabled) {
      throw new E3EditorError(
        E3_EDITOR_ERROR.INVALID_REQUEST,
        'E3 editor kernel is disabled by default'
      )
    }
    const resolved = path.resolve(workspaceRoot)
    for (const forbidden of forbiddenRoots.map(item => path.resolve(item))) {
      if (
        resolved === forbidden ||
        resolved.startsWith(`${forbidden}${path.sep}`) ||
        forbidden.startsWith(`${resolved}${path.sep}`)
      ) {
        throw new E3EditorError(
          E3_EDITOR_ERROR.FORBIDDEN_PATH,
          'Workspace root overlaps a protected root'
        )
      }
    }
    this.filesystem = new SafeTextFilesystem(resolved, filesystemOptions)
  }

  planMutation(input) {
    const request = validateEditorRequest(input)
    if (!E3_EDITOR_MUTATIONS.includes(request.type)) {
      throw new E3EditorError(
        E3_EDITOR_ERROR.INVALID_REQUEST,
        'Only mutation requests can be planned'
      )
    }
    let pathBefore = request.path ?? request.sourcePath ?? null
    let pathAfter = request.path ?? request.destinationPath ?? null
    let preimageSha256 = null
    let postimageSha256 = null
    let changedBytes = 0

    if (request.type === E3_EDITOR_OPERATION.CREATE_FILE) {
      try {
        this.filesystem.statFile(request.path)
        throw new E3EditorError(
          E3_EDITOR_ERROR.FILE_EXISTS,
          'Create target already exists'
        )
      } catch (error) {
        if (error?.code !== E3_EDITOR_ERROR.FILE_NOT_FOUND) throw error
      }
      postimageSha256 = sha256(Buffer.from(request.content, 'utf8'))
      changedBytes = Buffer.byteLength(request.content, 'utf8')
      pathBefore = null
    } else {
      const current = this.filesystem.readFile(pathBefore)
      preimageSha256 = current.sha256
      if (current.sha256 !== request.expectedSha256) {
        throw new E3EditorError(
          E3_EDITOR_ERROR.PREIMAGE_MISMATCH,
          'Mutation preimage does not match'
        )
      }
      if ([
        E3_EDITOR_OPERATION.REPLACE_EXACT,
        E3_EDITOR_OPERATION.INSERT_BEFORE,
        E3_EDITOR_OPERATION.INSERT_AFTER
      ].includes(request.type)) {
        const content = editedContent(request, current)
        postimageSha256 = sha256(Buffer.from(content, 'utf8'))
        changedBytes = Math.max(
          current.bytes,
          Buffer.byteLength(content, 'utf8')
        )
      } else if (request.type === E3_EDITOR_OPERATION.DELETE_FILE) {
        pathAfter = null
        changedBytes = current.bytes
      } else {
        const sourceParent = path.posix.dirname(request.sourcePath)
        const destinationParent = path.posix.dirname(request.destinationPath)
        const sameParent = sourceParent === destinationParent
        if (
          (request.type === E3_EDITOR_OPERATION.RENAME_FILE) !== sameParent
        ) {
          throw new E3EditorError(
            E3_EDITOR_ERROR.MOVE_SEMANTICS_MISMATCH,
            'Rename and move semantics do not match paths'
          )
        }
        try {
          this.filesystem.statFile(request.destinationPath)
          throw new E3EditorError(
            E3_EDITOR_ERROR.FILE_EXISTS,
            'Destination already exists'
          )
        } catch (error) {
          if (error?.code !== E3_EDITOR_ERROR.FILE_NOT_FOUND) throw error
        }
        postimageSha256 = current.sha256
        changedBytes = current.bytes
      }
    }
    return Object.freeze({
      version: E3_EDITOR_API_VERSION,
      pathPolicyVersion: E3_PATH_POLICY_VERSION,
      type: request.type,
      pathBefore,
      pathAfter,
      preimageSha256,
      postimageSha256,
      changedBytes
    })
  }

  execute(input) {
    const request = validateEditorRequest(input)
    let result
    switch (request.type) {
      case E3_EDITOR_OPERATION.READ_FILE:
        result = this.filesystem.readFile(request.path)
        break
      case E3_EDITOR_OPERATION.LIST_FILES:
        result = this.filesystem.listFiles(request.path)
        break
      case E3_EDITOR_OPERATION.STAT_FILE:
        result = this.filesystem.statFile(request.path)
        break
      case E3_EDITOR_OPERATION.SEARCH_TEXT:
        result = this.filesystem.searchText(
          request.path,
          request.query,
          request.maxResults
        )
        break
      case E3_EDITOR_OPERATION.CREATE_FILE:
        result = this.filesystem.createFile(request.path, request.content)
        break
      case E3_EDITOR_OPERATION.REPLACE_EXACT: {
        const current = this.filesystem.readFile(request.path)
        if (current.sha256 !== request.expectedSha256) {
          throw new E3EditorError(
            E3_EDITOR_ERROR.PREIMAGE_MISMATCH,
            'Replace preimage does not match'
          )
        }
        result = this.filesystem.replaceFile(
          request.path,
          request.expectedSha256,
          editedContent(request, current)
        )
        break
      }
      case E3_EDITOR_OPERATION.INSERT_BEFORE:
      case E3_EDITOR_OPERATION.INSERT_AFTER: {
        const current = this.filesystem.readFile(request.path)
        if (current.sha256 !== request.expectedSha256) {
          throw new E3EditorError(
            E3_EDITOR_ERROR.PREIMAGE_MISMATCH,
            'Insert preimage does not match'
          )
        }
        result = this.filesystem.replaceFile(
          request.path,
          request.expectedSha256,
          editedContent(request, current)
        )
        break
      }
      case E3_EDITOR_OPERATION.RENAME_FILE:
        result = this.filesystem.moveFile(
          request.sourcePath,
          request.destinationPath,
          request.expectedSha256,
          'rename'
        )
        break
      case E3_EDITOR_OPERATION.MOVE_FILE:
        result = this.filesystem.moveFile(
          request.sourcePath,
          request.destinationPath,
          request.expectedSha256,
          'move'
        )
        break
      case E3_EDITOR_OPERATION.DELETE_FILE:
        result = this.filesystem.deleteFile(
          request.path,
          request.expectedSha256
        )
        break
      default:
        throw new E3EditorError(
          E3_EDITOR_ERROR.UNKNOWN_OPERATION,
          'Editor operation has no implementation'
        )
    }
    return Object.freeze({
      version: E3_EDITOR_API_VERSION,
      pathPolicyVersion: E3_PATH_POLICY_VERSION,
      type: request.type,
      result
    })
  }
}
