function formatE3ActionResult(result, formatResult) {
  return String(formatResult(result) || '').trim()
}

function persistE3ActionContent({
  db,
  conversationId,
  content
}) {
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

function pendingEntryIsActive(entry) {
  if (typeof entry?.isRequestActive !== 'function') {
    return false
  }

  try {
    return entry.isRequestActive() === true
  } catch {
    return false
  }
}

function clearPendingEntry(
  pendingActions,
  actionId,
  entry
) {
  clearTimeout(entry?.timeout)
  pendingActions.delete(actionId)
}

export function persistE3ApprovalCompletion({
  db,
  result,
  formatResult
}) {
  return persistE3ActionContent({
    db,
    conversationId: Number(result?.conversationId),
    content: formatE3ActionResult(result, formatResult)
  })
}

export function settleE3ActionCompletion({
  pendingActions,
  actionId,
  db,
  result,
  formatResult
}) {
  const content = formatE3ActionResult(
    result,
    formatResult
  )
  const entry = pendingActions.get(actionId)
  const continued = pendingEntryIsActive(entry)

  if (entry) {
    clearPendingEntry(
      pendingActions,
      actionId,
      entry
    )
    entry.resolve(content)
  }

  const persisted = continued
    ? false
    : persistE3ActionContent({
        db,
        conversationId:
          Number(result?.conversationId),
        content
      })

  return Object.freeze({
    continued,
    persisted
  })
}

export function detachPendingE3ActionsForRequest({
  pendingActions,
  userId,
  conversationId,
  requestId
}) {
  const expectedUserId = Number(userId)
  const expectedConversationId =
    Number(conversationId)
  const expectedRequestId =
    String(requestId || '')
  let detached = 0

  for (
    const [actionId, entry] of pendingActions
  ) {
    if (
      Number(entry?.userId) !== expectedUserId ||
      Number(entry?.conversationId) !==
        expectedConversationId ||
      String(entry?.requestId || '') !==
        expectedRequestId
    ) {
      continue
    }

    clearPendingEntry(
      pendingActions,
      actionId,
      entry
    )
    entry.resolve(
      `E3 session ${entry.sessionId} remains READY_FOR_REVIEW. ` +
      'The approval card can be restored safely after reconnect.'
    )
    detached += 1
  }

  return detached
}
