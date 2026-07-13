const OPENAI_KEY =
  process.env.OPENAI_API_KEY || ''

const RESPONSES_URL =
  'https://api.openai.com/v1/responses'

const DEFAULT_SYSTEM_PROMPT = [
  'You are a precise document transcription and analysis engine.',
  'Read only information visibly present in the supplied images.',
  'Preserve names, identifiers, dates, currencies, decimal separators, totals, taxes, and line items exactly.',
  'Clearly mark unreadable or uncertain passages.',
  'Do not infer or invent missing information.',
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

function timeoutValue(value) {
  const parsed =
    Number.parseInt(value, 10)

  if (!Number.isFinite(parsed)) {
    return 180000
  }

  return Math.min(
    Math.max(parsed, 10000),
    300000
  )
}

function encodeImages(images) {
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

  return images.map(
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

      if (
        totalBytes >
        40 * 1024 * 1024
      ) {
        throw new Error(
          'Die Bilder überschreiten zusammen 40 MiB'
        )
      }

      const mimeType =
        String(
          image?.mimeType ||
          'image/jpeg'
        ).toLowerCase()

      const safeMimeType =
        [
          'image/jpeg',
          'image/png',
          'image/webp',
          'image/gif'
        ].includes(mimeType)
          ? mimeType
          : 'image/jpeg'

      return {
        type: 'input_image',
        detail: 'high',
        image_url:
          `data:${safeMimeType};base64,` +
          buffer.toString('base64')
      }
    }
  )
}

function extractOutputText(response) {
  if (
    typeof response?.output_text ===
    'string' &&
    response.output_text.trim()
  ) {
    return response.output_text.trim()
  }

  const pieces = []

  for (
    const item of response?.output || []
  ) {
    if (item?.type !== 'message') {
      continue
    }

    for (
      const part of item.content || []
    ) {
      if (
        part?.type === 'output_text' &&
        part.text
      ) {
        pieces.push(
          String(part.text)
        )
      }
    }
  }

  return pieces.join('\n').trim()
}

export async function analyzeImagesWithOpenAI({
  model,
  images,
  prompt,
  systemPrompt =
    DEFAULT_SYSTEM_PROMPT,
  timeoutMs = 180000
}) {
  if (!OPENAI_KEY) {
    throw new Error(
      'API-Key für OpenAI fehlt in der .env'
    )
  }

  const cleanModel =
    requiredText(
      model,
      'OpenAI-Vision-Modell',
      300
    )

  const cleanPrompt =
    requiredText(
      prompt,
      'Vision-Auftrag',
      20000
    )

  const cleanSystemPrompt =
    requiredText(
      systemPrompt,
      'Vision-Systemanweisung',
      20000
    )

  const imageParts =
    encodeImages(images)

  const controller =
    new AbortController()

  const timer = setTimeout(
    () => controller.abort(),
    timeoutValue(timeoutMs)
  )

  try {
    const response = await fetch(
      RESPONSES_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type':
            'application/json',
          Authorization:
            `Bearer ${OPENAI_KEY}`
        },
        body: JSON.stringify({
          model: cleanModel,
          store: false,
          instructions:
            cleanSystemPrompt,
          input: [
            {
              role: 'user',
              content: [
                {
                  type: 'input_text',
                  text: cleanPrompt
                },
                ...imageParts
              ]
            }
          ],
          max_output_tokens: 12000
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
        'OpenAI lieferte keine gültige JSON-Antwort'
      )
    }

    if (!response.ok || data?.error) {
      const message =
        data?.error?.message ||
        data?.error ||
        raw.slice(0, 1000)

      throw new Error(
        `OpenAI Vision ${response.status}: ${message}`
      )
    }

    const content =
      extractOutputText(data)

    if (!content) {
      throw new Error(
        'Das OpenAI-Vision-Modell lieferte keinen Dokumenttext'
      )
    }

    const usage =
      data.usage || {}

    return {
      model:
        data.model || cleanModel,
      content,
      tokenUsage: {
        promptTokens:
          Number(
            usage.input_tokens
          ) || 0,
        completionTokens:
          Number(
            usage.output_tokens
          ) || 0,
        totalTokens:
          Number(
            usage.total_tokens
          ) ||
          (
            Number(
              usage.input_tokens
            ) || 0
          ) +
          (
            Number(
              usage.output_tokens
            ) || 0
          )
      }
    }
  } catch (error) {
    if (
      error?.name === 'AbortError'
    ) {
      throw new Error(
        'OpenAI-Vision-Analyse hat das Zeitlimit überschritten'
      )
    }

    throw error
  } finally {
    clearTimeout(timer)
  }
}
