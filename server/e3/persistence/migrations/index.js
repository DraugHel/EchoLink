import { createHash } from 'node:crypto'
import { migration001 } from './001-initial-schema.js'
import { migration002 } from './002-workspaces.js'
import { migration003 } from './003-operation-intents.js'
import { migration004 } from './004-candidate-artifacts.js'
import { migration005 } from './005-review-evidence.js'

export const EDITOR_MIGRATIONS = Object.freeze([
  migration001,
  migration002,
  migration003,
  migration004,
  migration005
])

export function editorMigrationChecksum(migration) {
  return createHash('sha256')
    .update(String(migration.version))
    .update('\0')
    .update(migration.name)
    .update('\0')
    .update(migration.sql)
    .digest('hex')
}
