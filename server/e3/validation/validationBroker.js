import {
  assertCanonicalSessionId,
  assertFullGitCommit,
  assertSha256,
  freezeDomainValue
} from '../core/contracts.js'
import { validationBrokerFeatureEnabled } from './contracts.js'
import {
  E3_VALIDATION_ERROR,
  E3ValidationError
} from './errors.js'
import {
  validationSnapshotHandle
} from './snapshotMaterializer.js'
import { compileValidationPlan } from './validationPlanner.js'

function brokerError(code, message, details = {}, cause) {
  throw new E3ValidationError(
    code,
    message,
    details,
    cause ? { cause } : {}
  )
}

function validateCandidate(candidate, plan) {
  if (!candidate || typeof candidate !== 'object') {
    brokerError(
      E3_VALIDATION_ERROR.INVALID_CANDIDATE,
      'Candidate resolver returned no candidate'
    )
  }
  assertCanonicalSessionId(candidate.id)
  assertCanonicalSessionId(candidate.sessionId)
  assertFullGitCommit(candidate.baseCommit)
  assertSha256(
    candidate.candidateManifestSha256,
    'candidateManifestSha256'
  )
  if (
    candidate.id !== plan.candidateSetId ||
    candidate.sessionId !== plan.sessionId ||
    candidate.candidateManifestSha256 !==
      plan.candidateManifestSha256 ||
    !(Buffer.isBuffer(candidate.manifestBytes) ||
      typeof candidate.manifestBytes === 'string') ||
    !(Buffer.isBuffer(candidate.forwardPatch) ||
      typeof candidate.forwardPatch === 'string')
  ) {
    brokerError(
      E3_VALIDATION_ERROR.INVALID_CANDIDATE,
      'Resolved candidate does not match the validation plan'
    )
  }
  return candidate
}

export class ValidationBroker {
  constructor({
    registry,
    actualRuntimeVersion,
    snapshotMaterializer,
    runtime,
    candidateResolver,
    env = {}
  }) {
    this.registry = registry
    this.actualRuntimeVersion = actualRuntimeVersion
    this.snapshotMaterializer = snapshotMaterializer
    this.runtime = runtime
    this.candidateResolver = candidateResolver
    this.enabled = validationBrokerFeatureEnabled(env)
  }

  run(rawRequest) {
    if (!this.enabled) {
      brokerError(
        E3_VALIDATION_ERROR.FEATURE_DISABLED,
        'E3 validation broker is disabled'
      )
    }
    const plan = compileValidationPlan(rawRequest, {
      registry: this.registry,
      actualRuntimeVersion: this.actualRuntimeVersion
    })
    const expectedHandle = validationSnapshotHandle(
      plan.sessionId,
      plan.runId
    )
    if (plan.snapshotHandle !== expectedHandle) {
      brokerError(
        E3_VALIDATION_ERROR.INVALID_SNAPSHOT,
        'Snapshot handle is not derived from the run identity'
      )
    }
    const candidate = validateCandidate(
      this.candidateResolver({
        candidateSetId: plan.candidateSetId,
        sessionId: plan.sessionId
      }),
      plan
    )
    let snapshot
    let cleanupError
    try {
      snapshot = this.snapshotMaterializer.materialize({
        runId: plan.runId,
        sessionId: plan.sessionId,
        baseCommit: candidate.baseCommit,
        candidateManifestSha256:
          candidate.candidateManifestSha256,
        manifestBytes: candidate.manifestBytes,
        forwardPatch: candidate.forwardPatch
      })
      if (snapshot.handle !== plan.snapshotHandle) {
        brokerError(
          E3_VALIDATION_ERROR.INVALID_SNAPSHOT,
          'Materialized snapshot handle does not match the plan'
        )
      }
      this.snapshotMaterializer.verify(
        snapshot,
        candidate.manifestBytes
      )
      const runtimeResult = this.runtime.run(plan, snapshot)
      this.snapshotMaterializer.verify(
        snapshot,
        candidate.manifestBytes
      )
      return freezeDomainValue({
        status: runtimeResult.status,
        runId: plan.runId,
        sessionId: plan.sessionId,
        candidateSetId: plan.candidateSetId,
        candidateManifestSha256:
          plan.candidateManifestSha256,
        profileId: plan.profile.id,
        profileSha256: plan.profile.sha256,
        profileSetSha256: plan.profileSet.sha256,
        requestSha256: plan.requestSha256,
        planSha256: plan.planSha256,
        exitCode: runtimeResult.exitCode,
        signal: runtimeResult.signal,
        stdout: runtimeResult.stdout,
        stderr: runtimeResult.stderr,
        outputBytes: runtimeResult.outputBytes
      })
    } finally {
      if (snapshot) {
        try {
          this.snapshotMaterializer.remove(snapshot)
        } catch (error) {
          cleanupError = error
        }
      }
      if (cleanupError) {
        brokerError(
          E3_VALIDATION_ERROR.CLEANUP_FAILED,
          'Validation snapshot cleanup failed',
          {},
          cleanupError
        )
      }
    }
  }
}
