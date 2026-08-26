// Memory extraction through the Z.ai General API.
// Kept isolated from Express/DB so provider routing can be tested directly.

const ZAI_CHAT_URL =
  'https://api.z.ai/api/paas/v4/chat/completions'

export function zaiMemoryRequestExtras(model) {
  const apiModel = String(model || '')
    .trim()
    .replace(/^zai\//, '')

  // GLM-5.3-family models require thinking to stay enabled.
  // Use the lowest supported effort for bounded background extraction.
  if (/^glm-5\.3(?:$|-)/i.test(apiModel)) {
    return {
      thinking: { type: 'enabled' },
      reasoning_effort: 'low'
    }
  }

  // Do not force a thinking mode on other/future Z.ai models here.
  // Provider defaults are safer than sending an unsupported control.
  return {}
}

export async function runZaiMemory({
  model,
  prompt,
  apiKey,
  fetchImpl = fetch,
  timeoutMs = 120000
}) {
  if (!apiKey) {
    throw new Error(
      'ZAI_API_KEY fehlt'
    )
  }

  const apiModel =
    String(model || '')
      .trim()
      .replace(/^zai\//, '')

  if (!apiModel) {
    throw new Error(
      'Kein Z.ai-Modell angegeben'
    )
  }

  const controller =
    new AbortController()

  const timer = setTimeout(
    () => controller.abort(),
    timeoutMs
  )

  let response

  try {
    response = await fetchImpl(
      ZAI_CHAT_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type':
            'application/json',
          Authorization:
            `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: apiModel,
          messages: [
            {
              role: 'user',
              content: prompt
            }
          ],
          stream: false,
          max_tokens: 4000,
          temperature: 0.3,
          ...zaiMemoryRequestExtras(apiModel)
        }),
        signal: controller.signal
      }
    )
  } finally {
    clearTimeout(timer)
  }

  const raw = await response.text()

  let data

  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error(
      'Z.ai lieferte keine gültige JSON-Antwort'
    )
  }

  if (!response.ok || data?.error) {
    throw new Error(
      `Z.ai Memory ${response.status}: ` +
      String(
        data?.error?.message ||
        data?.error ||
        raw
      ).slice(0, 300)
    )
  }

  const content =
    data?.choices?.[0]?.message?.content

  if (typeof content !== 'string') {
    throw new Error(
      'Z.ai lieferte keine Text-Antwort'
    )
  }

  return content.trim()
}
