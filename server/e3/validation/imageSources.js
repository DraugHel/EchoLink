export const E3_VALIDATION_IMAGE_SOURCE_VERSION = 1

export const E3_NODE_VALIDATION_BASE = Object.freeze({
  reference:
    'node:24.18.0-bookworm-slim@sha256:' +
    '6f7b03f7c2c8e2e784dcf9295400527b' +
    '9b1270fd37b7e9a7285cf83b6951452d',
  runtimeVersion: '24.18.0',
  os: 'linux',
  architecture: 'amd64'
})

export const E3_PLAYWRIGHT_VALIDATION_BASE = Object.freeze({
  reference:
    'mcr.microsoft.com/playwright:v1.61.1-noble@sha256:' +
    '5b8f294aff9041b7191c34a4bab3ac27' +
    '0157a28774d4b0660e9743297b697e48',
  playwrightVersion: '1.61.1',
  os: 'linux',
  architecture: 'amd64'
})
