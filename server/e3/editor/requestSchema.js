import { Buffer } from 'node:buffer'
import {
  E3_EDITOR_API_VERSION,
  E3_EDITOR_LIMITS,
  E3_EDITOR_OPERATION,
  E3_EDITOR_OPERATIONS
} from './contracts.js'
import {
  E3_EDITOR_ERROR,
  E3EditorError
} from './errors.js'
import { assertEditorPath } from './pathPolicy.js'

const SCHEMAS = Object.freeze({
  [E3_EDITOR_OPERATION.READ_FILE]: {
    required: ['path']
  },
  [E3_EDITOR_OPERATION.LIST_FILES]: {
    required: [],
    optional: ['path']
  },
  [E3_EDITOR_OPERATION.STAT_FILE]: {
    required: ['path']
  },
  [E3_EDITOR_OPERATION.SEARCH_TEXT]: {
    required: ['query'],
    optional: ['path', 'maxResults']
  },
  [E3_EDITOR_OPERATION.CREATE_FILE]: {
    required: ['path', 'content']
  },
  [E3_EDITOR_OPERATION.REPLACE_EXACT]: {
    required: [
      'path',
      'expectedSha256',
      'search',
      'replacement'
    ],
    optional: ['expectedMatches']
  },
  [E3_EDITOR_OPERATION.INSERT_BEFORE]: {
    required: [
      'path',
      'expectedSha256',
      'anchor',
      'content'
    ],
    optional: ['expectedMatches']
  },
  [E3_EDITOR_OPERATION.INSERT_AFTER]: {
    required: [
      'path',
      'expectedSha256',
      'anchor',
      'content'
    ],
    optional: ['expectedMatches']
  },
  [E3_EDITOR_OPERATION.RENAME_FILE]: {
    required: [
      'sourcePath',
      'destinationPath',
      'expectedSha256'
    ]
  },
  [E3_EDITOR_OPERATION.MOVE_FILE]: {
    required: [
      'sourcePath',
      'destinationPath',
      'expectedSha256'
    ]
  },
  [E3_EDITOR_OPERATION.DELETE_FILE]: {
    required: ['path', 'expectedSha256']
  }
})

function requestError(code, message, details = {}) {
  throw new E3EditorError(code, message, details)
}

function assertText(value, fieldName, {
  allowEmpty = true
} = {}) {
  if (
    typeof value !== 'string' ||
    value.includes('\0') ||
    (!allowEmpty && value.length === 0) ||
    Buffer.from(value, 'utf8').toString('utf8') !== value
  ) {
    requestError(
      E3_EDITOR_ERROR.INVALID_REQUEST,
      `${fieldName} must be valid UTF-8 text`
    )
  }
  return value
}

function assertSha256(value, fieldName) {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value)
  ) {
    requestError(
      E3_EDITOR_ERROR.INVALID_REQUEST,
      `${fieldName} must be a lowercase SHA-256`
    )
  }
  return value
}

function expectedMatches(value) {
  const normalized = value ?? 1
  if (
    !Number.isSafeInteger(normalized) ||
    normalized < 1 ||
    normalized > E3_EDITOR_LIMITS.maxExpectedMatches
  ) {
    requestError(
      E3_EDITOR_ERROR.INVALID_REQUEST,
      'expectedMatches is outside the V1 limit'
    )
  }
  return normalized
}

function optionalRootPath(value) {
  if (value === undefined || value === null) return null
  return assertEditorPath(value).relativePath
}

export function validateEditorRequest(request) {
  if (
    !request ||
    typeof request !== 'object' ||
    Array.isArray(request)
  ) {
    requestError(
      E3_EDITOR_ERROR.INVALID_REQUEST,
      'Editor request must be an object'
    )
  }
  let requestBytes
  try {
    requestBytes = Buffer.byteLength(JSON.stringify(request), 'utf8')
  } catch {
    requestError(
      E3_EDITOR_ERROR.INVALID_REQUEST,
      'Editor request must be JSON-compatible'
    )
  }
  if (requestBytes > E3_EDITOR_LIMITS.maxRequestBytes) {
    requestError(
      E3_EDITOR_ERROR.REQUEST_TOO_LARGE,
      'Editor request exceeds the V1 byte limit'
    )
  }
  if (request.version !== E3_EDITOR_API_VERSION) {
    requestError(
      E3_EDITOR_ERROR.UNSUPPORTED_VERSION,
      'Editor request version is unsupported'
    )
  }
  if (
    typeof request.type !== 'string' ||
    !E3_EDITOR_OPERATIONS.includes(request.type)
  ) {
    requestError(
      E3_EDITOR_ERROR.UNKNOWN_OPERATION,
      'Editor operation is not registered'
    )
  }

  const schema = SCHEMAS[request.type]
  const allowed = new Set([
    'version',
    'type',
    ...schema.required,
    ...(schema.optional ?? [])
  ])
  const unknown = Object.keys(request)
    .filter(key => !allowed.has(key))
  const missing = schema.required
    .filter(key => request[key] === undefined)
  if (unknown.length > 0 || missing.length > 0) {
    requestError(
      E3_EDITOR_ERROR.INVALID_REQUEST,
      'Editor request fields do not match the operation schema',
      { unknown, missing }
    )
  }

  switch (request.type) {
    case E3_EDITOR_OPERATION.READ_FILE:
    case E3_EDITOR_OPERATION.STAT_FILE:
    case E3_EDITOR_OPERATION.DELETE_FILE:
      return Object.freeze({
        ...request,
        path: assertEditorPath(request.path, {
          mutation: request.type ===
            E3_EDITOR_OPERATION.DELETE_FILE
        }).relativePath,
        ...(request.expectedSha256 === undefined
          ? {}
          : {
              expectedSha256: assertSha256(
                request.expectedSha256,
                'expectedSha256'
              )
            })
      })
    case E3_EDITOR_OPERATION.LIST_FILES:
      return Object.freeze({
        ...request,
        path: optionalRootPath(request.path)
      })
    case E3_EDITOR_OPERATION.SEARCH_TEXT: {
      const maxResults = request.maxResults ??
        E3_EDITOR_LIMITS.maxSearchResults
      if (
        !Number.isSafeInteger(maxResults) ||
        maxResults < 1 ||
        maxResults > E3_EDITOR_LIMITS.maxSearchResults
      ) {
        requestError(
          E3_EDITOR_ERROR.INVALID_REQUEST,
          'maxResults is outside the V1 limit'
        )
      }
      return Object.freeze({
        ...request,
        path: optionalRootPath(request.path),
        query: assertText(request.query, 'query', {
          allowEmpty: false
        }),
        maxResults
      })
    }
    case E3_EDITOR_OPERATION.CREATE_FILE:
      return Object.freeze({
        ...request,
        path: assertEditorPath(request.path, {
          mutation: true
        }).relativePath,
        content: assertText(request.content, 'content')
      })
    case E3_EDITOR_OPERATION.REPLACE_EXACT:
      return Object.freeze({
        ...request,
        path: assertEditorPath(request.path, {
          mutation: true
        }).relativePath,
        expectedSha256: assertSha256(
          request.expectedSha256,
          'expectedSha256'
        ),
        search: assertText(request.search, 'search', {
          allowEmpty: false
        }),
        replacement: assertText(
          request.replacement,
          'replacement'
        ),
        expectedMatches: expectedMatches(request.expectedMatches)
      })
    case E3_EDITOR_OPERATION.INSERT_BEFORE:
    case E3_EDITOR_OPERATION.INSERT_AFTER:
      return Object.freeze({
        ...request,
        path: assertEditorPath(request.path, {
          mutation: true
        }).relativePath,
        expectedSha256: assertSha256(
          request.expectedSha256,
          'expectedSha256'
        ),
        anchor: assertText(request.anchor, 'anchor', {
          allowEmpty: false
        }),
        content: assertText(request.content, 'content'),
        expectedMatches: expectedMatches(request.expectedMatches)
      })
    case E3_EDITOR_OPERATION.RENAME_FILE:
    case E3_EDITOR_OPERATION.MOVE_FILE:
      return Object.freeze({
        ...request,
        sourcePath: assertEditorPath(request.sourcePath, {
          mutation: true
        }).relativePath,
        destinationPath: assertEditorPath(
          request.destinationPath,
          { mutation: true }
        ).relativePath,
        expectedSha256: assertSha256(
          request.expectedSha256,
          'expectedSha256'
        )
      })
    default:
      requestError(
        E3_EDITOR_ERROR.UNKNOWN_OPERATION,
        'Editor operation is not implemented'
      )
  }
}
