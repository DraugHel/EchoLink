import db, { DEFAULT_MODEL } from '../db.js'

function safeConversationTitle(title) {
  const value = String(title || '').trim()

  if (/morning\s*briefing/i.test(value)) {
    return 'Morning Briefings'
  }

  const base = value || 'Geplante Aufgabe'
  return `${base} – Task`
}

export function getOwnedConversation(
  userId,
  conversationId
) {
  const id = Number(conversationId)

  if (!Number.isInteger(id) || id < 1) {
    return null
  }

  return db.prepare(`
    SELECT *
    FROM conversations
    WHERE id = ? AND user_id = ?
  `).get(id, userId)
}

export function createDedicatedTaskConversation({
  userId,
  title,
  templateConversationId
}) {
  const template = getOwnedConversation(
    userId,
    templateConversationId
  )

  const user = db.prepare(`
    SELECT default_system_prompt
    FROM users
    WHERE id = ?
  `).get(userId)

  const systemPrompt = template?.system_prompt ??
    user?.default_system_prompt ??
    process.env.DEFAULT_SYSTEM_PROMPT ??
    ''

  const result = db.prepare(`
    INSERT INTO conversations (
      user_id,
      title,
      model,
      system_prompt,
      temperature,
      top_k,
      top_p
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    safeConversationTitle(title),
    template?.model || DEFAULT_MODEL,
    systemPrompt,
    template?.temperature ?? 0.5,
    template?.top_k ?? 40,
    template?.top_p ?? 0.9
  )

  return getOwnedConversation(
    userId,
    Number(result.lastInsertRowid)
  )
}
