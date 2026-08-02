export function persistE3ApprovalCompletion({
  db,
  result,
  formatResult
}) {
  const conversationId = Number(result?.conversationId)
  const content = String(formatResult(result) || '').trim()

  if (
    !Number.isSafeInteger(conversationId) ||
    conversationId <= 0 ||
    !content
  ) {
    return false
  }

  const insert = db.prepare(`
    INSERT INTO messages (conversation_id, role, content)
    SELECT ?, 'assistant', ?
    WHERE EXISTS (
      SELECT 1 FROM conversations WHERE id = ?
    )
      AND NOT EXISTS (
        SELECT 1
        FROM messages
        WHERE conversation_id = ?
          AND role = 'assistant'
          AND content = ?
      )
  `)
  const inserted = insert.run(
    conversationId,
    content,
    conversationId,
    conversationId,
    content
  )

  if (inserted.changes > 0) {
    db.prepare(
      'UPDATE conversations SET updated_at = unixepoch() WHERE id = ?'
    ).run(conversationId)
    return true
  }

  return false
}
