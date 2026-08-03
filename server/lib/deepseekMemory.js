// Memory-Extraktion über die DeepSeek-API (OpenAI-kompatibler Endpoint).
// Bewusst in server/lib isoliert, damit sie ohne Express-/DB-Importe
// direkt getestet werden kann (siehe tests/memoryDeepSeek.test.mjs).

const DEEPSEEK_CHAT_URL =
  'https://api.deepseek.com/chat/completions'

export async function runDeepSeekMemory({
  model,
  prompt,
  apiKey,
  fetchImpl = fetch,
  timeoutMs = 120000
}) {
  if (!apiKey) {
    throw new Error(
      'DEEPSEEK_API_KEY fehlt'
    )
  }

  const apiModel =
    String(model || '')
      .trim()
      .replace(/^deepseek\//, '')

  if (!apiModel) {
    throw new Error(
      'Kein DeepSeek-Modell angegeben'
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
      DEEPSEEK_CHAT_URL,
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
          // DeepSeek-Thinking ist standardmäßig aktiv und
          // macht temperature unwirksam. Für deterministische
          // Memory-Extraktion ausdrücklich deaktivieren.
          thinking: {
            type: 'disabled'
          },
          temperature: 0.3,
          top_p: 0.9
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
      'DeepSeek lieferte keine gültige JSON-Antwort'
    )
  }

  if (!response.ok || data?.error) {
    throw new Error(
      `DeepSeek Memory ${response.status}: ` +
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
      'DeepSeek lieferte keine Text-Antwort'
    )
  }

  return content.trim()
}
