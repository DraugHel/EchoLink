export const E3_WORKSPACE_STATE = Object.freeze({
  PROVISIONING: 'PROVISIONING',
  READY: 'READY',
  REMOVING: 'REMOVING',
  REMOVED: 'REMOVED',
  QUARANTINED: 'QUARANTINED'
})

export const E3_WORKSPACE_STATES = Object.freeze(
  Object.values(E3_WORKSPACE_STATE)
)

export const E3_WORKSPACE_MANIFEST_VERSION = 1
export const E3_WORKSPACE_FEATURE_FLAG =
  'E3_WORKSPACE_ENABLED'

export function workspaceFeatureEnabled(env = {}) {
  return env[E3_WORKSPACE_FEATURE_FLAG] === 'true'
}
