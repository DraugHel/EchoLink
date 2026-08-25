import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  ALLOWED_VISION_MODELS,
  DEFAULT_VISION_MODEL,
  isAllowedVisionModel,
  resolveActiveModel,
  resolveVisionModel
} from '../server/lib/visionModels.js'

const DEEPSEEK =
  'deepseek/deepseek-v4-flash-vision-exp'
const LUNA = 'openai/gpt-5.6-luna'

test('vision allowlist contains exactly the two supported models', () => {
  assert.deepEqual(
    [...ALLOWED_VISION_MODELS],
    [DEEPSEEK, LUNA]
  )
  assert.equal(DEFAULT_VISION_MODEL, LUNA)
})

test('user vision selection overrides the environment', () => {
  assert.equal(
    resolveVisionModel(LUNA, DEEPSEEK),
    LUNA
  )
})

test('DeepSeek environment fallback is used for an empty user setting', () => {
  assert.equal(
    resolveVisionModel('', DEEPSEEK),
    DEEPSEEK
  )
})

test('invalid or empty user and environment values fall back to Luna', () => {
  assert.equal(
    resolveVisionModel('', ''),
    LUNA
  )
  assert.equal(
    resolveVisionModel('invalid/user', 'invalid/env'),
    LUNA
  )
})

test('legacy Kimi cloud vision model is rejected', () => {
  assert.equal(
    isAllowedVisionModel('kimi-k2.7-code:cloud'),
    false
  )
  assert.equal(
    resolveVisionModel('', 'kimi-k2.7-code:cloud'),
    LUNA
  )
})

test('only allowlisted API model values are valid', () => {
  assert.equal(isAllowedVisionModel(DEEPSEEK), true)
  assert.equal(isAllowedVisionModel(LUNA), true)
  assert.equal(isAllowedVisionModel('openai/gpt-4o'), false)
  assert.equal(isAllowedVisionModel(null), false)
})

test('text messages keep the conversation model', () => {
  assert.equal(
    resolveActiveModel({
      hasImages: false,
      chatModel: 'deepseek/deepseek-v4-flash',
      userVisionModel: LUNA,
      envVisionModel: DEEPSEEK
    }),
    'deepseek/deepseek-v4-flash'
  )
})

test('image messages use the resolved vision model', () => {
  assert.equal(
    resolveActiveModel({
      hasImages: true,
      chatModel: 'deepseek/deepseek-v4-flash',
      userVisionModel: LUNA,
      envVisionModel: DEEPSEEK
    }),
    LUNA
  )
})

test('auth route exposes and validates the global vision setting', () => {
  const source = fs.readFileSync(
    new URL('../server/routes/auth.js', import.meta.url),
    'utf8'
  )

  assert.match(
    source,
    /router\.get\('\/vision-model'/
  )
  assert.match(
    source,
    /router\.patch\('\/vision-model'/
  )
  assert.match(source, /isAllowedVisionModel\(model\)/)
  assert.match(source, /UPDATE users SET vision_model = \?/)
})

test('database migration is additive and nullable', () => {
  const source = fs.readFileSync(
    new URL('../server/db.js', import.meta.url),
    'utf8'
  )

  assert.match(
    source,
    /ALTER TABLE users ADD COLUMN vision_model TEXT/
  )
  assert.doesNotMatch(
    source,
    /DROP\s+(?:TABLE|COLUMN).*vision_model/i
  )
})

test('settings panel loads and immediately saves the global selection', () => {
  const source = fs.readFileSync(
    new URL(
      '../client/src/components/SettingsPanel.jsx',
      import.meta.url
    ),
    'utf8'
  )

  assert.match(source, /get\('\/api\/auth\/vision-model'\)/)
  assert.match(source, /patch\(\s*'\/api\/auth\/vision-model'/)
  assert.match(source, /DeepSeek V4 Flash Vision Exp/)
  assert.match(source, /GPT-5\.6 Luna/)
  assert.match(
    source,
    /Normale Nachrichten verwenden\s+weiterhin das Chatmodell\./
  )
})
