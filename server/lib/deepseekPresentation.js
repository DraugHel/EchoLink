const DEEPSEEK_PRESENTATION_MARKER =
  '[DeepSeek user-facing response policy]'

export const DEEPSEEK_USER_FACING_POLICY = [
  DEEPSEEK_PRESENTATION_MARKER,
  'Answer the user directly. Do not narrate how you gathered the answer.',
  '',
  'Hide process provenance by default:',
  '- Do not announce that data was freshly read, re-read, verified live, or not taken from memory unless the user explicitly asks how you know or that fact materially affects correctness.',
  '- Do not mention tool calls, searches, pagination, page numbers, page sizes, batch counts, API calls, retries, or internal workflow.',
  '- Do not expose implementation metadata such as updatedAt values, internal IDs, raw timestamps, token counts, or backend field names unless directly relevant or explicitly requested.',
  '- Do not state that the turn was read-only or that nothing was written unless the user asks whether something changed or that fact is important for safety/correctness.',
  '- Do not include self-commentary, self-corrections, or remarks about your own process unless the correction materially changes the answer.',
  '- Do not append generic offers such as "say if I should do X next" unless the user explicitly asks what to do next.',
  '',
  'For audits and checks:',
  '- State what is correct.',
  '- State what is still wrong, incomplete, or unresolved.',
  '- Include only evidence needed to understand those conclusions.',
  '- Do not describe how the evidence was gathered.',
  '',
  'Prefer concise Markdown.',
  'Do not add a redundant bottom-line, recap, or conclusion section when the answer is already clear.'
].join('\n')

export function applyDeepSeekUserFacingPolicy(
  messages,
  model
) {
  if (
    !String(model || '')
      .toLowerCase()
      .startsWith('deepseek/')
  ) {
    return messages
  }

  const source = Array.isArray(messages)
    ? messages
    : []
  const out = source.map(message => ({ ...message }))

  const systemIndex = out.findIndex(
    message => message?.role === 'system'
  )

  if (systemIndex === -1) {
    return [
      {
        role: 'system',
        content: DEEPSEEK_USER_FACING_POLICY
      },
      ...out
    ]
  }

  const current = String(
    out[systemIndex]?.content || ''
  )

  if (current.includes(DEEPSEEK_PRESENTATION_MARKER)) {
    return out
  }

  out[systemIndex] = {
    ...out[systemIndex],
    content: current
      ? `${current}\n\n${DEEPSEEK_USER_FACING_POLICY}`
      : DEEPSEEK_USER_FACING_POLICY
  }

  return out
}
