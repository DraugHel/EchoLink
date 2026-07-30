export const E3_EDITOR_API_VERSION = 1
export const E3_PATH_POLICY_VERSION = 'e3-path-v1'

export const E3_EDITOR_OPERATION = Object.freeze({
  READ_FILE: 'read_file',
  LIST_FILES: 'list_files',
  STAT_FILE: 'stat_file',
  SEARCH_TEXT: 'search_text',
  CREATE_FILE: 'create_file',
  REPLACE_EXACT: 'replace_exact',
  INSERT_BEFORE: 'insert_before',
  INSERT_AFTER: 'insert_after',
  RENAME_FILE: 'rename_file',
  MOVE_FILE: 'move_file',
  DELETE_FILE: 'delete_file'
})

export const E3_EDITOR_OPERATIONS = Object.freeze(
  Object.values(E3_EDITOR_OPERATION)
)

export const E3_EDITOR_MUTATIONS = Object.freeze([
  E3_EDITOR_OPERATION.CREATE_FILE,
  E3_EDITOR_OPERATION.REPLACE_EXACT,
  E3_EDITOR_OPERATION.INSERT_BEFORE,
  E3_EDITOR_OPERATION.INSERT_AFTER,
  E3_EDITOR_OPERATION.RENAME_FILE,
  E3_EDITOR_OPERATION.MOVE_FILE,
  E3_EDITOR_OPERATION.DELETE_FILE
])

export const E3_EDITOR_LIMITS = Object.freeze({
  maxFileBytes: 2 * 1024 * 1024,
  maxRequestBytes: 4 * 1024 * 1024,
  maxSearchResults: 1_000,
  maxPathBytes: 1_024,
  maxSegmentBytes: 255,
  maxExpectedMatches: 10_000
})
