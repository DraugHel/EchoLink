import {
  E3_VALIDATION_NETWORK_MODE,
  E3_VALIDATION_RUNTIME
} from './contracts.js'
import { freezeDomainValue } from '../core/contracts.js'
import { buildValidationEnvironment } from './environmentPolicy.js'
import {
  E3_VALIDATION_ERROR,
  E3ValidationError
} from './errors.js'
import {
  canonicalValidationJson,
  validationSha256
} from './profileRegistry.js'
import { validateValidationRequest } from './requestSchema.js'

function assertRuntimeVersion(actualRuntimeVersion) {
  if (actualRuntimeVersion !== E3_VALIDATION_RUNTIME.version) {
    throw new E3ValidationError(
      E3_VALIDATION_ERROR.RUNTIME_VERSION_MISMATCH,
      'Validation runtime version does not match the profile set',
      {
        expectedVersion: E3_VALIDATION_RUNTIME.version,
        actualVersion: actualRuntimeVersion
      }
    )
  }
}

function assertProfileSet(request, registry) {
  if (request.profileSetSha256 !== registry.sha256) {
    throw new E3ValidationError(
      E3_VALIDATION_ERROR.PROFILE_SET_MISMATCH,
      'Validation request targets another profile set',
      {
        expectedSha256: registry.sha256,
        actualSha256: request.profileSetSha256
      }
    )
  }
}

export function compileValidationPlan(rawRequest, {
  registry,
  actualRuntimeVersion
}) {
  const request = validateValidationRequest(rawRequest)
  assertRuntimeVersion(actualRuntimeVersion)
  assertProfileSet(request, registry)
  const profile = registry.get(
    request.profileId,
    request.profileVersion
  )
  const environment = buildValidationEnvironment({
    runId: request.runId,
    sessionId: request.sessionId,
    snapshotHandle: request.snapshotHandle,
    candidateManifestSha256:
      request.candidateManifestSha256,
    profileId: profile.id,
    profileSha256: profile.sha256
  })
  const unsignedPlan = {
    version: 1,
    runId: request.runId,
    sessionId: request.sessionId,
    candidateSetId: request.candidateSetId,
    candidateManifestSha256:
      request.candidateManifestSha256,
    snapshotHandle: request.snapshotHandle,
    requestedAt: request.requestedAt,
    lease: {
      owner: request.leaseOwner,
      fencingToken: request.fencingToken
    },
    profileSet: {
      version: registry.version,
      sha256: registry.sha256
    },
    profile,
    environment,
    isolation: {
      rootFilesystem: 'read_only',
      capabilities: [],
      noNewPrivileges: true,
      privileged: false,
      hostPid: false,
      hostIpc: false,
      devices: [],
      dockerSocket: false,
      hostNetwork: false,
      networkMode: profile.networkMode,
      internetEgress: false,
      productionMounts: false
    }
  }
  if (
    unsignedPlan.isolation.networkMode !==
      E3_VALIDATION_NETWORK_MODE.NONE &&
    unsignedPlan.isolation.networkMode !==
      E3_VALIDATION_NETWORK_MODE.INTERNAL_PAIR
  ) {
    throw new E3ValidationError(
      E3_VALIDATION_ERROR.UNSAFE_PROFILE,
      'Validation plan contains an unsupported network mode'
    )
  }
  const requestSha256 = validationSha256(request)
  const planSha256 = validationSha256(unsignedPlan)
  return freezeDomainValue({
    ...unsignedPlan,
    requestSha256,
    planSha256,
    manifest: canonicalValidationJson({
      ...unsignedPlan,
      requestSha256,
      planSha256
    })
  })
}
