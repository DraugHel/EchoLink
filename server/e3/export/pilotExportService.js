import { createHash, randomUUID } from 'node:crypto'
import {
  E3_ARTIFACT_TYPE,
  E3_LEASE_RESOURCE_TYPE,
  E3_SESSION_COMMAND,
  E3_SESSION_STATUS,
  assertCanonicalSessionId,
  assertFencingToken,
  assertSafeToken,
  assertSha256,
  assertTimestamp,
  freezeDomainValue
} from '../core/contracts.js'
import { transitionEditorSession } from '../core/sessionState.js'
import { ArtifactStore } from '../artifacts/artifactStore.js'
import { EditorRepository } from '../persistence/editorRepository.js'
import { ApprovalGate } from '../approval/approvalGate.js'
import { canonicalApprovalJson } from '../approval/contracts.js'
import {
  E3_PILOT_EXPORT_FORMAT,
  E3_PILOT_EXPORT_MANIFEST_FIELDS,
  E3_PILOT_EXPORT_POLICY,
  E3_PILOT_EXPORT_POLICY_SHA256,
  E3_PILOT_EXPORT_POLICY_VERSION,
  E3_PILOT_EXPORT_REQUEST_FIELDS,
  canonicalExportJson,
  exportSha256,
  pilotExportFeatureEnabled
} from './contracts.js'
import {
  E3_PILOT_EXPORT_ERROR,
  E3PilotExportError
} from './errors.js'
import {
  buildDeterministicTar,
  parseDeterministicTar
} from './deterministicTar.js'

const CANDIDATE_PATHS = Object.freeze({
  candidate_manifest: 'candidate/candidate-manifest.json',
  forward_patch: 'patches/forward.patch',
  reverse_patch: 'patches/reverse.patch',
  unified_diff: 'review/unified.diff',
  diff_stat: 'review/diff-stat.txt'
})

function exportError(code, message, details = {}, cause) {
  throw new E3PilotExportError(
    code,
    message,
    details,
    cause ? { cause } : {}
  )
}

function exactFields(
  value,
  expected,
  label = 'Pilot export request',
  code = E3_PILOT_EXPORT_ERROR.INVALID_REQUEST
) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    exportError(
      code,
      `${label} must be an object`
    )
  }
  const actual = Object.keys(value).sort()
  const fields = [...expected].sort()
  if (
    actual.length !== fields.length ||
    actual.some((field, index) => field !== fields[index])
  ) {
    exportError(
      code,
      `${label} fields do not match the V1 contract`
    )
  }
}

function assertEnvelope(input) {
  exactFields(input, E3_PILOT_EXPORT_REQUEST_FIELDS)
  try {
    assertCanonicalSessionId(input.sessionId)
    assertCanonicalSessionId(input.approvalId)
    assertSafeToken(input.actorId, 'actorId')
    assertSafeToken(input.requestId, 'requestId', {
      minLength: 8,
      maxLength: 160
    })
    assertTimestamp(input.occurredAt, 'occurredAt')
    assertSafeToken(input.leaseOwner, 'leaseOwner')
    assertFencingToken(input.fencingToken)
  } catch (cause) {
    exportError(
      E3_PILOT_EXPORT_ERROR.INVALID_REQUEST,
      'Pilot export request envelope is invalid',
      {},
      cause
    )
  }
  if (
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1
  ) {
    exportError(
      E3_PILOT_EXPORT_ERROR.STALE_SESSION,
      'Pilot export expectedVersion is invalid'
    )
  }
}

function rowToExport(row) {
  if (!row) return null
  return freezeDomainValue({
    id: row.id,
    sessionId: row.session_id,
    approvalId: row.approval_id,
    approvedSessionVersion: row.approved_session_version,
    exportedSessionVersion: row.exported_session_version,
    reviewSetId: row.review_set_id,
    candidateSetId: row.candidate_set_id,
    baseCommit: row.base_commit,
    candidateManifestSha256: row.candidate_manifest_sha256,
    forwardPatchSha256: row.forward_patch_sha256,
    reversePatchSha256: row.reverse_patch_sha256,
    validationManifestSha256: row.validation_manifest_sha256,
    reviewSummarySha256: row.review_summary_sha256,
    approvalStatementSha256: row.approval_statement_sha256,
    exportPolicyVersion: row.export_policy_version,
    exportPolicySha256: row.export_policy_sha256,
    exportManifestSha256: row.export_manifest_sha256,
    packageArtifactId: row.package_artifact_id,
    packageSha256: row.package_sha256,
    packageSizeBytes: row.package_size_bytes,
    requestSha256: row.request_sha256,
    actorId: row.actor_id,
    requestId: row.request_id,
    createdAt: row.created_at
  })
}

function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function eventRequestId(requestId, phase) {
  return `e3-export-${phase}-${exportSha256(requestId).slice(0, 32)}`
}

function sessionParameters(session) {
  return {
    id: session.id,
    status: session.status,
    updatedAt: session.updatedAt,
    reviewReadyAt: session.reviewReadyAt,
    candidateManifestSha256:
      session.candidate?.candidateManifestSha256 ?? null,
    patchSha256: session.candidate?.patchSha256 ?? null,
    validationManifestSha256:
      session.candidate?.validationManifestSha256 ?? null,
    pathPolicyVersion:
      session.candidate?.pathPolicyVersion ?? null,
    profileSetVersion:
      session.candidate?.profileSetVersion ?? null,
    approvedBy: session.approval?.approvedBy ?? null,
    approvedAt: session.approval?.approvedAt ?? null,
    exportSha256: session.exportArtifact?.sha256 ?? null,
    exportedAt: session.exportArtifact?.exportedAt ?? null,
    failureCode: session.failure?.code ?? null,
    failureMessage: session.failure?.message ?? null,
    failedAt: session.failure?.failedAt ?? null,
    version: session.version
  }
}

function updateSession(database, session, expectedVersion) {
  const update = database.prepare(`
    UPDATE editor_sessions
    SET
      status = @status,
      updated_at = @updatedAt,
      review_ready_at = @reviewReadyAt,
      candidate_manifest_sha256 = @candidateManifestSha256,
      patch_sha256 = @patchSha256,
      validation_manifest_sha256 = @validationManifestSha256,
      path_policy_version = @pathPolicyVersion,
      profile_set_version = @profileSetVersion,
      approved_by = @approvedBy,
      approved_at = @approvedAt,
      export_sha256 = @exportSha256,
      exported_at = @exportedAt,
      failure_code = @failureCode,
      failure_message = @failureMessage,
      failed_at = @failedAt,
      version = @version
    WHERE id = @id AND version = @expectedVersion
  `).run({
    ...sessionParameters(session),
    expectedVersion
  })
  if (update.changes !== 1) {
    exportError(
      E3_PILOT_EXPORT_ERROR.STALE_SESSION,
      'Session changed during pilot export transaction'
    )
  }
}

function insertEvent(database, event) {
  const result = database.prepare(`
    INSERT INTO editor_events (
      session_id, sequence, event_type, from_status, to_status,
      actor_id, request_id, version_before, version_after,
      metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.sessionId,
    event.versionAfter,
    event.type,
    event.fromStatus,
    event.toStatus,
    event.actorId,
    event.requestId,
    event.versionBefore,
    event.versionAfter,
    canonicalExportJson(event.metadata),
    event.occurredAt
  )
  return Number(result.lastInsertRowid)
}

function artifactEntry(path, kind, bytes, metadata = {}) {
  const content = Buffer.from(bytes)
  return {
    path,
    kind,
    sha256: sha256Buffer(content),
    sizeBytes: content.length,
    content,
    ...metadata
  }
}

function approvalPayloadEntries(verified) {
  const entries = []
  for (const [type, path] of Object.entries(CANDIDATE_PATHS)) {
    const bytes = verified.candidateBytes[type]
    if (!bytes) {
      exportError(
        E3_PILOT_EXPORT_ERROR.APPROVAL_MISMATCH,
        'Verified approval is missing a candidate artifact',
        { type }
      )
    }
    entries.push(artifactEntry(path, type, bytes))
  }
  entries.push(artifactEntry(
    'review/validation-manifest.json',
    E3_ARTIFACT_TYPE.VALIDATION_MANIFEST,
    verified.validationBytes
  ))
  entries.push(artifactEntry(
    'review/review-summary.json',
    E3_ARTIFACT_TYPE.REVIEW_SUMMARY,
    verified.summaryBytes
  ))
  entries.push(artifactEntry(
    'approval/approval-statement.json',
    'approval_statement',
    canonicalApprovalJson(verified.approval.statement)
  ))
  verified.evidence.forEach((evidence, index) => {
    entries.push(artifactEntry(
      `validation/logs/${String(index + 1).padStart(4, '0')}.log`,
      E3_ARTIFACT_TYPE.VALIDATION_LOG,
      evidence.logBytes,
      {
        evidenceId: evidence.id,
        profileId: evidence.profileId,
        profileVersion: evidence.profileVersion
      }
    ))
  })
  return entries.sort(
    (left, right) => left.path.localeCompare(right.path, 'en')
  )
}

function entryMetadata(entry) {
  const { content, ...metadata } = entry
  return metadata
}

function packageFromApproval(verified, input) {
  const entries = approvalPayloadEntries(verified)
  const fileManifest = entries.map(entryMetadata)
  const approval = verified.approval
  const candidate = verified.candidate
  const manifest = {
    version: 1,
    format: E3_PILOT_EXPORT_FORMAT,
    exportPolicyVersion: E3_PILOT_EXPORT_POLICY_VERSION,
    exportPolicySha256: E3_PILOT_EXPORT_POLICY_SHA256,
    manualApplyOnly: true,
    productiveApplyEnabled: false,
    sessionId: approval.sessionId,
    approvedSessionVersion: approval.approvedSessionVersion,
    exportedSessionVersion: approval.approvedSessionVersion + 2,
    baseCommit: approval.baseCommit,
    approvalId: approval.id,
    approvalStatementSha256: approval.statementSha256,
    approvalActorId: approval.actorId,
    approvedAt: approval.createdAt,
    reviewSetId: approval.reviewSetId,
    candidateSetId: approval.candidateSetId,
    candidateManifestSha256: approval.candidateManifestSha256,
    forwardPatchSha256: approval.forwardPatchSha256,
    reversePatchSha256: candidate.reverse_patch_sha256,
    unifiedDiffSha256: candidate.unified_diff_sha256,
    diffStatSha256: candidate.diff_stat_sha256,
    validationManifestSha256: approval.validationManifestSha256,
    reviewSummarySha256: approval.reviewSummarySha256,
    pathPolicyVersion: approval.pathPolicyVersion,
    profileSetVersion: approval.profileSetVersion,
    profileSetSha256: approval.profileSetSha256,
    reviewPolicyVersion: approval.reviewPolicyVersion,
    reviewPolicySha256: approval.reviewPolicySha256,
    approvalPolicyVersion: approval.approvalPolicyVersion,
    approvalPolicySha256: approval.approvalPolicySha256,
    generatedBy: input.actorId,
    generatedAt: input.occurredAt,
    checksumsPath: 'SHA256SUMS',
    files: fileManifest
  }
  const manifestBytes = Buffer.from(canonicalExportJson(manifest), 'utf8')
  const checksums = Buffer.from(
    `${entries.map(entry => `${entry.sha256}  ${entry.path}`).join('\n')}\n`,
    'utf8'
  )
  const packageBytes = buildDeterministicTar([
    ...entries.map(entry => ({
      name: entry.path,
      content: entry.content
    })),
    {
      name: 'E3-EXPORT-MANIFEST.json',
      content: manifestBytes
    },
    {
      name: 'SHA256SUMS',
      content: checksums
    }
  ])
  if (packageBytes.length > E3_PILOT_EXPORT_POLICY.maxPackageBytes) {
    exportError(
      E3_PILOT_EXPORT_ERROR.PACKAGE_TOO_LARGE,
      'Pilot export package exceeds the V1 byte limit'
    )
  }
  return {
    manifest,
    manifestBytes,
    manifestSha256: sha256Buffer(manifestBytes),
    packageBytes,
    packageSha256: sha256Buffer(packageBytes)
  }
}

function mapEntries(packageBytes) {
  try {
    return new Map(
      parseDeterministicTar(packageBytes, {
        maxBytes: E3_PILOT_EXPORT_POLICY.maxPackageBytes
      }).map(entry => [entry.name, entry.content])
    )
  } catch (cause) {
    exportError(
      E3_PILOT_EXPORT_ERROR.PACKAGE_INVALID,
      'Pilot export package is not deterministic USTAR V1',
      {},
      cause
    )
  }
}

function parseCanonicalJson(bytes, label) {
  let value
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch (cause) {
    exportError(
      E3_PILOT_EXPORT_ERROR.PACKAGE_INVALID,
      `${label} is not valid JSON`,
      {},
      cause
    )
  }
  if (!bytes.equals(Buffer.from(canonicalExportJson(value), 'utf8'))) {
    exportError(
      E3_PILOT_EXPORT_ERROR.PACKAGE_INVALID,
      `${label} is not canonical JSON`
    )
  }
  return value
}

function verifyPayloadBinding(manifest, verified) {
  if (!Array.isArray(manifest.files)) {
    exportError(
      E3_PILOT_EXPORT_ERROR.PACKAGE_INVALID,
      'Pilot export manifest files must be an array'
    )
  }
  const expected = approvalPayloadEntries(verified).map(entryMetadata)
  if (
    manifest.files.length !== expected.length ||
    manifest.files.some((file, index) =>
      canonicalExportJson(file) !== canonicalExportJson(expected[index])
    )
  ) {
    exportError(
      E3_PILOT_EXPORT_ERROR.APPROVAL_MISMATCH,
      'Pilot export payload manifest differs from approved artifacts'
    )
  }
}

function verifyChecksums(entries, manifest) {
  const checksums = entries.get('SHA256SUMS')
  if (!checksums) {
    exportError(
      E3_PILOT_EXPORT_ERROR.PACKAGE_INVALID,
      'Pilot export package has no SHA256SUMS'
    )
  }
  const expected = `${manifest.files
    .map(file => `${file.sha256}  ${file.path}`)
    .join('\n')}\n`
  if (!checksums.equals(Buffer.from(expected, 'utf8'))) {
    exportError(
      E3_PILOT_EXPORT_ERROR.PACKAGE_INVALID,
      'Pilot export SHA256SUMS is not canonical'
    )
  }
  const allowed = new Set([
    'E3-EXPORT-MANIFEST.json',
    'SHA256SUMS',
    ...manifest.files.map(file => file.path)
  ])
  if (
    allowed.size !== entries.size ||
    [...entries.keys()].some(name => !allowed.has(name))
  ) {
    exportError(
      E3_PILOT_EXPORT_ERROR.PACKAGE_INVALID,
      'Pilot export package contains unexpected entries'
    )
  }
  for (const file of manifest.files) {
    const bytes = entries.get(file.path)
    if (
      !bytes ||
      bytes.length !== file.sizeBytes ||
      sha256Buffer(bytes) !== file.sha256
    ) {
      exportError(
        E3_PILOT_EXPORT_ERROR.ARTIFACT_TAMPERED,
        'Pilot export payload failed checksum verification',
        { path: file.path }
      )
    }
  }
}

export class PilotExportService {
  constructor(database, {
    artifactRoot,
    env = {},
    idFactory = randomUUID,
    faultInjector = () => {}
  }) {
    this.database = database
    this.store = new ArtifactStore(artifactRoot)
    this.sessions = new EditorRepository(database)
    this.approvals = new ApprovalGate(database, {
      artifactRoot,
      env: { E3_APPROVAL_GATE_ENABLED: 'true' }
    })
    this.enabled = pilotExportFeatureEnabled(env)
    this.idFactory = idFactory
    this.faultInjector = faultInjector
  }

  getForRequest(sessionId, requestId) {
    assertCanonicalSessionId(sessionId)
    assertSafeToken(requestId, 'requestId', {
      minLength: 8,
      maxLength: 160
    })
    return rowToExport(this.database.prepare(`
      SELECT * FROM editor_pilot_export_records
      WHERE session_id = ? AND request_id = ?
    `).get(sessionId, requestId))
  }

  getById(id) {
    assertCanonicalSessionId(id)
    return rowToExport(this.database.prepare(`
      SELECT * FROM editor_pilot_export_records WHERE id = ?
    `).get(id))
  }

  #assertLease(input) {
    const lease = this.sessions.getLease(
      E3_LEASE_RESOURCE_TYPE.SESSION,
      input.sessionId
    )
    if (
      !lease ||
      lease.owner !== input.leaseOwner ||
      lease.fencingToken !== input.fencingToken ||
      lease.expiresAt <= input.occurredAt
    ) {
      exportError(
        E3_PILOT_EXPORT_ERROR.LEASE_REQUIRED,
        'Pilot export requires the current unexpired session lease'
      )
    }
    return lease
  }

  #verifyPersisted(record) {
    const artifact = this.database.prepare(`
      SELECT * FROM editor_artifacts WHERE id = ?
    `).get(record.packageArtifactId)
    if (
      !artifact ||
      artifact.session_id !== record.sessionId ||
      artifact.artifact_type !== E3_ARTIFACT_TYPE.EXPORT_PACKAGE ||
      artifact.sha256 !== record.packageSha256 ||
      artifact.size_bytes !== record.packageSizeBytes
    ) {
      exportError(
        E3_PILOT_EXPORT_ERROR.ARTIFACT_TAMPERED,
        'Persisted export artifact metadata does not match'
      )
    }
    let packageBytes
    try {
      packageBytes = this.store.read(record.packageSha256)
    } catch (cause) {
      exportError(
        E3_PILOT_EXPORT_ERROR.ARTIFACT_TAMPERED,
        'Persisted export package failed content verification',
        {},
        cause
      )
    }
    const entries = mapEntries(packageBytes)
    const manifestBytes = entries.get('E3-EXPORT-MANIFEST.json')
    if (!manifestBytes) {
      exportError(
        E3_PILOT_EXPORT_ERROR.PACKAGE_INVALID,
        'Pilot export package has no manifest'
      )
    }
    const manifest = parseCanonicalJson(
      manifestBytes,
      'Pilot export manifest',
      E3_PILOT_EXPORT_ERROR.PACKAGE_INVALID
    )
    if (sha256Buffer(manifestBytes) !== record.exportManifestSha256) {
      exportError(
        E3_PILOT_EXPORT_ERROR.ARTIFACT_TAMPERED,
        'Pilot export manifest hash does not match its record'
      )
    }
    exactFields(
      manifest,
      E3_PILOT_EXPORT_MANIFEST_FIELDS,
      'Pilot export manifest'
    )
    if (
      record.exportPolicyVersion !== E3_PILOT_EXPORT_POLICY_VERSION ||
      record.exportPolicySha256 !== E3_PILOT_EXPORT_POLICY_SHA256
    ) {
      exportError(
        E3_PILOT_EXPORT_ERROR.APPROVAL_MISMATCH,
        'Persisted export policy is not the current fixed policy'
      )
    }
    const approval = this.approvals.verifyById(record.approvalId)
    const expected = {
      version: 1,
      format: E3_PILOT_EXPORT_FORMAT,
      exportPolicyVersion: E3_PILOT_EXPORT_POLICY_VERSION,
      exportPolicySha256: E3_PILOT_EXPORT_POLICY_SHA256,
      manualApplyOnly: true,
      productiveApplyEnabled: false,
      sessionId: record.sessionId,
      approvedSessionVersion: record.approvedSessionVersion,
      exportedSessionVersion: record.exportedSessionVersion,
      baseCommit: record.baseCommit,
      approvalId: record.approvalId,
      approvalStatementSha256: record.approvalStatementSha256,
      approvalActorId: approval.approval.actorId,
      approvedAt: approval.approval.createdAt,
      reviewSetId: record.reviewSetId,
      candidateSetId: record.candidateSetId,
      candidateManifestSha256: record.candidateManifestSha256,
      forwardPatchSha256: record.forwardPatchSha256,
      reversePatchSha256: record.reversePatchSha256,
      unifiedDiffSha256: approval.candidate.unified_diff_sha256,
      diffStatSha256: approval.candidate.diff_stat_sha256,
      validationManifestSha256: record.validationManifestSha256,
      reviewSummarySha256: record.reviewSummarySha256,
      pathPolicyVersion: approval.approval.pathPolicyVersion,
      profileSetVersion: approval.approval.profileSetVersion,
      profileSetSha256: approval.approval.profileSetSha256,
      reviewPolicyVersion: approval.approval.reviewPolicyVersion,
      reviewPolicySha256: approval.approval.reviewPolicySha256,
      approvalPolicyVersion: approval.approval.approvalPolicyVersion,
      approvalPolicySha256: approval.approval.approvalPolicySha256,
      generatedBy: record.actorId,
      generatedAt: record.createdAt,
      checksumsPath: 'SHA256SUMS'
    }
    for (const [field, value] of Object.entries(expected)) {
      if (manifest[field] !== value) {
        exportError(
          E3_PILOT_EXPORT_ERROR.APPROVAL_MISMATCH,
          `Pilot export manifest does not match ${field}`,
          { field }
        )
      }
    }
    if (
      approval.approval.statementSha256 !==
        record.approvalStatementSha256 ||
      approval.approval.approvedSessionVersion !==
        record.approvedSessionVersion
    ) {
      exportError(
        E3_PILOT_EXPORT_ERROR.APPROVAL_MISMATCH,
        'Pilot export no longer matches its approval record'
      )
    }
    verifyPayloadBinding(manifest, approval)
    verifyChecksums(entries, manifest)
    const session = this.sessions.getSession(record.sessionId)
    if (
      ![E3_SESSION_STATUS.EXPORTED, E3_SESSION_STATUS.COMPLETED]
        .includes(session?.status) ||
      session.version < record.exportedSessionVersion ||
      session.exportArtifact?.sha256 !== record.packageSha256
    ) {
      exportError(
        E3_PILOT_EXPORT_ERROR.EXPORT_CONFLICT,
        'Pilot export record does not match exported session state'
      )
    }
    return { record, session, manifest, packageBytes }
  }

  exportApproved(input) {
    if (!this.enabled) {
      exportError(
        E3_PILOT_EXPORT_ERROR.FEATURE_DISABLED,
        'E3 pilot export is disabled'
      )
    }
    assertEnvelope(input)
    const requestSha256 = exportSha256({
      version: 1,
      exportPolicySha256: E3_PILOT_EXPORT_POLICY_SHA256,
      ...input
    })
    const existing = this.getForRequest(input.sessionId, input.requestId)
    if (existing) {
      if (existing.requestSha256 !== requestSha256) {
        exportError(
          E3_PILOT_EXPORT_ERROR.IDEMPOTENCY_CONFLICT,
          'Pilot export request ID was reused for another request'
        )
      }
      const verified = this.#verifyPersisted(existing)
      return freezeDomainValue({
        export: existing,
        session: verified.session,
        replayed: true
      })
    }
    const session = this.sessions.getSession(input.sessionId)
    if (session?.status !== E3_SESSION_STATUS.APPROVED) {
      exportError(
        E3_PILOT_EXPORT_ERROR.SESSION_NOT_APPROVED,
        'Pilot export requires an approved session'
      )
    }
    if (session.version !== input.expectedVersion) {
      exportError(
        E3_PILOT_EXPORT_ERROR.STALE_SESSION,
        'Pilot export received a stale session version'
      )
    }
    this.#assertLease(input)
    let verifiedApproval
    try {
      verifiedApproval = this.approvals.verifyForExport(input.approvalId)
    } catch (cause) {
      exportError(
        E3_PILOT_EXPORT_ERROR.APPROVAL_MISMATCH,
        'Pilot export approval verification failed',
        {},
        cause
      )
    }
    if (
      verifiedApproval.approval.sessionId !== input.sessionId ||
      verifiedApproval.approval.approvedSessionVersion !==
        input.expectedVersion
    ) {
      exportError(
        E3_PILOT_EXPORT_ERROR.APPROVAL_MISMATCH,
        'Pilot export approval is bound to another session version'
      )
    }
    const built = packageFromApproval(verifiedApproval, input)
    const published = this.store.publish(built.packageBytes)
    if (published.sha256 !== built.packageSha256) {
      exportError(
        E3_PILOT_EXPORT_ERROR.ARTIFACT_TAMPERED,
        'Published pilot export package hash changed'
      )
    }
    this.faultInjector('after_package_publish', { published })

    const transaction = this.database.transaction(() => {
      const replay = this.getForRequest(input.sessionId, input.requestId)
      if (replay) {
        if (replay.requestSha256 !== requestSha256) {
          exportError(
            E3_PILOT_EXPORT_ERROR.IDEMPOTENCY_CONFLICT,
            'Concurrent pilot export reused the request ID'
          )
        }
        return { replay }
      }
      const approvalExport = this.database.prepare(`
        SELECT * FROM editor_pilot_export_records
        WHERE approval_id = ?
      `).get(input.approvalId)
      if (approvalExport) {
        exportError(
          E3_PILOT_EXPORT_ERROR.EXPORT_CONFLICT,
          'Approval already has another pilot export'
        )
      }
      const current = this.sessions.getSession(input.sessionId)
      if (
        current?.status !== E3_SESSION_STATUS.APPROVED ||
        current.version !== input.expectedVersion
      ) {
        exportError(
          E3_PILOT_EXPORT_ERROR.STALE_SESSION,
          'Approved session changed before export commit'
        )
      }
      const lease = this.#assertLease(input)
      const currentApproval = this.approvals.getById(input.approvalId)
      if (
        !currentApproval ||
        currentApproval.statementSha256 !==
          verifiedApproval.approval.statementSha256 ||
        currentApproval.approvedSessionVersion !== input.expectedVersion
      ) {
        exportError(
          E3_PILOT_EXPORT_ERROR.APPROVAL_MISMATCH,
          'Approval changed before export commit'
        )
      }
      const artifactId = this.idFactory()
      assertCanonicalSessionId(artifactId)
      this.database.prepare(`
        INSERT INTO editor_artifacts (
          id, session_id, artifact_type, storage_key, sha256,
          size_bytes, retention_class, created_at, pinned
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
      `).run(
        artifactId,
        input.sessionId,
        E3_ARTIFACT_TYPE.EXPORT_PACKAGE,
        published.storageKey,
        published.sha256,
        published.sizeBytes,
        'pilot-export-v1',
        input.occurredAt
      )
      this.faultInjector('after_artifact_record', { artifactId })

      const start = transitionEditorSession(current, {
        type: E3_SESSION_COMMAND.START_EXPORT,
        sessionId: input.sessionId,
        expectedVersion: input.expectedVersion,
        actorId: input.actorId,
        requestId: eventRequestId(input.requestId, 'start'),
        occurredAt: input.occurredAt,
        leaseOwner: input.leaseOwner,
        fencingToken: input.fencingToken
      }, { currentLease: lease })
      updateSession(this.database, start.session, current.version)
      const startEventId = insertEvent(this.database, start.event)
      this.faultInjector('after_start_transition', { startEventId })

      const finish = transitionEditorSession(start.session, {
        type: E3_SESSION_COMMAND.FINISH_EXPORT,
        sessionId: input.sessionId,
        expectedVersion: start.session.version,
        actorId: input.actorId,
        requestId: eventRequestId(input.requestId, 'finish'),
        occurredAt: input.occurredAt,
        leaseOwner: input.leaseOwner,
        fencingToken: input.fencingToken,
        exportSha256: published.sha256
      }, { currentLease: lease })
      updateSession(this.database, finish.session, start.session.version)
      const finishEventId = insertEvent(this.database, finish.event)
      this.faultInjector('after_finish_transition', { finishEventId })

      const id = this.idFactory()
      assertCanonicalSessionId(id)
      this.database.prepare(`
        INSERT INTO editor_pilot_export_records (
          id, session_id, approval_id, approved_session_version,
          exported_session_version, review_set_id, candidate_set_id,
          base_commit, candidate_manifest_sha256, forward_patch_sha256,
          reverse_patch_sha256, validation_manifest_sha256,
          review_summary_sha256, approval_statement_sha256,
          export_policy_version, export_policy_sha256,
          export_manifest_sha256, package_artifact_id, package_sha256,
          package_size_bytes, request_sha256, actor_id, request_id,
          created_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?
        )
      `).run(
        id,
        input.sessionId,
        input.approvalId,
        input.expectedVersion,
        finish.session.version,
        currentApproval.reviewSetId,
        currentApproval.candidateSetId,
        currentApproval.baseCommit,
        currentApproval.candidateManifestSha256,
        currentApproval.forwardPatchSha256,
        verifiedApproval.candidate.reverse_patch_sha256,
        currentApproval.validationManifestSha256,
        currentApproval.reviewSummarySha256,
        currentApproval.statementSha256,
        E3_PILOT_EXPORT_POLICY_VERSION,
        E3_PILOT_EXPORT_POLICY_SHA256,
        built.manifestSha256,
        artifactId,
        published.sha256,
        published.sizeBytes,
        requestSha256,
        input.actorId,
        input.requestId,
        input.occurredAt
      )
      this.faultInjector('after_export_record', { id })
      return {
        record: this.getById(id),
        session: finish.session,
        startEventId,
        finishEventId
      }
    })

    let committed
    try {
      committed = transaction.immediate()
    } catch (cause) {
      if (cause instanceof E3PilotExportError) throw cause
      exportError(
        E3_PILOT_EXPORT_ERROR.PERSISTENCE_FAILED,
        'Pilot export transaction failed',
        {},
        cause
      )
    }
    if (committed.replay) {
      const verified = this.#verifyPersisted(committed.replay)
      return freezeDomainValue({
        export: verified.record,
        session: verified.session,
        replayed: true
      })
    }
    const verified = this.#verifyPersisted(committed.record)
    return freezeDomainValue({
      export: committed.record,
      session: verified.session,
      replayed: false
    })
  }
}
