const OLLAMA_URL =
  process.env.OLLAMA_URL ||
  'http://localhost:11434'

const DEFAULT_SYSTEM_PROMPT = [
  'You are a document transcription and analysis engine.',
  'Read only information visibly present in the supplied images.',
  'Preserve names, dates, currencies, identifiers, totals, and decimal separators exactly.',
  'Clearly mark text that is unreadable or uncertain.',
  'Do not invent missing information.',
  'Do not add jokes, roleplay, personality remarks, or unrelated commentary.'
].join(' ')

function requiredText(
  value,
  name,
  maxLength
) {
  if (typeof value !== 'string') {
    throw new TypeError(
      `${name} muss Text sein`
    )
  }

  const clean = value.trim()

  if (!clean) {
    throw new Error(
      `${name} fehlt`
    )
  }

  if (clean.length > maxLength) {
    throw new Error(
      `${name} ist zu lang`
    )
  }

  return clean
}

function validateImages(images) {
  if (
    !Array.isArray(images) ||
    images.length < 1
  ) {
    throw new Error(
      'Mindestens ein Bild ist erforderlich'
    )
  }

  if (images.length > 10) {
    throw new Error(
      'Maximal zehn Bilder pro Vision-Aufruf'
    )
  }

  let totalBytes = 0

  const encoded = images.map(
    (image, index) => {
      const buffer =
        Buffer.isBuffer(image)
          ? image
          : image?.buffer

      if (!Buffer.isBuffer(buffer)) {
        throw new TypeError(
          `Bild ${index + 1} ist kein Buffer`
        )
      }

      if (!buffer.length) {
        throw new Error(
          `Bild ${index + 1} ist leer`
        )
      }

      if (
        buffer.length >
        10 * 1024 * 1024
      ) {
        throw new Error(
          `Bild ${index + 1} überschreitet 10 MiB`
        )
      }

      totalBytes += buffer.length

      return buffer.toString('base64')
    }
  )

  if (
    totalBytes >
    40 * 1024 * 1024
  ) {
    throw new Error(
      'Die Bilder überschreiten zusammen 40 MiB'
    )
  }

  return encoded
}

function timeoutValue(value) {
  const parsed =
    Number.parseInt(value, 10)

  if (!Number.isFinite(parsed)) {
    return 180_000
  }

  return Math.min(
    Math.max(parsed, 10_000),
    300_000
  )
}

export async function analyzeImagesWithOllama({
  model,
  images,
  prompt,
  systemPrompt =
    DEFAULT_SYSTEM_PROMPT,
  timeoutMs = 180_000
}) {
  const cleanModel =
    requiredText(
      model,
      'Vision-Modell',
      300
    )

  const cleanPrompt =
    requiredText(
      prompt,
      'Vision-Auftrag',
      20_000
    )

  const cleanSystemPrompt =
    requiredText(
      systemPrompt,
      'Vision-Systemanweisung',
      20_000
    )

  const encodedImages =
    validateImages(images)

  const controller =
    new AbortController()

  const timer = setTimeout(
    () => controller.abort(),
    timeoutValue(timeoutMs)
  )

  try {
    const response = await fetch(
      `${OLLAMA_URL}/api/chat`,
      {
        method: 'POST',
        headers: {
          'Content-Type':
            'application/json'
        },
        body: JSON.stringify({
          model: cleanModel,
          stream: false,
          think: false,
          messages: [
            {
              role: 'system',
              content:
                cleanSystemPrompt
            },
            {
              role: 'user',
              content:
                cleanPrompt,
              images:
                encodedImages
            }
          ],
          options: {
            temperature: 0,
            top_p: 0.9
          }
        }),
        signal: controller.signal
      }
    )

    const raw =
      await response.text()

    let data

    try {
      data = JSON.parse(raw)
    } catch {
      throw new Error(
        'Ollama lieferte keine gültige JSON-Antwort'
      )
    }

    if (!response.ok || data?.error) {
      throw new Error(
        `Ollama Vision ${
          response.status
        }: ${
          data?.error ||
          raw.slice(0, 500)
        }`
      )
    }

    const content =
      String(
        data?.message?.content || ''
      ).trim()

    if (!content) {
      throw new Error(
        'Das Vision-Modell lieferte keinen Dokumenttext'
      )
    }

    return {
      model: cleanModel,
      content,
      thinking:
        String(
          data?.message?.thinking || ''
        ).trim(),
      tokenUsage: {
        promptTokens:
          Number(
            data?.prompt_eval_count
          ) || 0,
        completionTokens:
          Number(
            data?.eval_count
          ) || 0,
        totalTokens:
          (
            Number(
              data?.prompt_eval_count
            ) || 0
          ) +
          (
            Number(
              data?.eval_count
            ) || 0
          )
      }
    }
  } catch (error) {
    if (
      error?.name === 'AbortError'
    ) {
      throw new Error(
        'Ollama-Vision-Analyse hat das Zeitlimit überschritten'
      )
    }

    throw error
  } finally {
    clearTimeout(timer)
  }
}
