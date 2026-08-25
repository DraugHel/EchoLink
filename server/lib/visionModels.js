export const ALLOWED_VISION_MODELS = Object.freeze([
  'deepseek/deepseek-v4-flash-vision-exp',
  'openai/gpt-5.6-luna'
])

export const DEFAULT_VISION_MODEL =
  'openai/gpt-5.6-luna'

function normalizeModel(value) {
  return typeof value === 'string'
    ? value.trim()
    : ''
}

export function isAllowedVisionModel(value) {
  return ALLOWED_VISION_MODELS.includes(
    normalizeModel(value)
  )
}

export function resolveVisionModel(
  userModel,
  envModel = process.env.VISION_MODEL
) {
  const normalizedUserModel =
    normalizeModel(userModel)

  if (isAllowedVisionModel(normalizedUserModel)) {
    return normalizedUserModel
  }

  const normalizedEnvModel =
    normalizeModel(envModel)

  if (isAllowedVisionModel(normalizedEnvModel)) {
    return normalizedEnvModel
  }

  return DEFAULT_VISION_MODEL
}

export function resolveActiveModel({
  hasImages,
  chatModel,
  userVisionModel,
  envVisionModel
}) {
  return hasImages
    ? resolveVisionModel(
        userVisionModel,
        envVisionModel
      )
    : chatModel
}
