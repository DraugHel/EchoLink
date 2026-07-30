import path from 'node:path'
import {
  E3_EDITOR_API_VERSION,
  E3_EDITOR_OPERATION,
  E3_PATH_POLICY_VERSION
} from './contracts.js'
import { E3_EDITOR_ERROR, E3EditorError } from './errors.js'
import { validateEditorRequest } from './requestSchema.js'
import { SafeTextFilesystem } from './safeTextFilesystem.js'

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
        assertMatches(
          countOccurrences(current.content, request.search),
          request.expectedMatches
        )
        result = this.filesystem.replaceFile(
          request.path,
          request.expectedSha256,
          current.content.split(request.search)
            .join(request.replacement)
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
        assertMatches(
          countOccurrences(current.content, request.anchor),
          request.expectedMatches
        )
        const replacement = request.type ===
          E3_EDITOR_OPERATION.INSERT_BEFORE
          ? `${request.content}${request.anchor}`
          : `${request.anchor}${request.content}`
        result = this.filesystem.replaceFile(
          request.path,
          request.expectedSha256,
          current.content.split(request.anchor).join(replacement)
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
