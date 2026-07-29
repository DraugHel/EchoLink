import { createHash } from 'node:crypto'
import { migration001 } from './001-initial-schema.js'
import { migration002 } from './002-workspaces.js'

export const EDITOR_MIGRATIONS = Object.freeze([
  migration001,
  migration002
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
