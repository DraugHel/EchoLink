#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  E3_VALIDATION_PROFILE_IDS,
  E3_VALIDATION_PROFILE_ID,
  E3_VALIDATION_RUNTIME
} from '../server/e3/validation/contracts.js'
import { DockerValidationRuntime } from '../server/e3/validation/dockerRuntime.js'
import { DockerUiValidationRuntime } from '../server/e3/validation/dockerUiRuntime.js'
import { loadValidationImageManifest } from '../server/e3/validation/imageManifest.js'
import { ValidationProfileRegistry } from '../server/e3/validation/profileRegistry.js'
import { validationSnapshotHandle } from '../server/e3/validation/snapshotMaterializer.js'
import { compileValidationPlan } from '../server/e3/validation/validationPlanner.js'


function assertSmokePaths(snapshotRoot, snapshotPath, outputRoot) {
  const backupRoot = '/root/echolink-patch-backups'
  const smokeRoot = path.dirname(snapshotRoot)
  const name = path.basename(smokeRoot)
  if (
    path.dirname(smokeRoot) !== backupRoot ||
    !/^e3-validation-smoke-[0-9a-f]{12}$/.test(name) ||
    snapshotRoot !== path.join(smokeRoot, 'snapshots') ||
    snapshotPath !== path.join(snapshotRoot, 'source/snapshot') ||
    outputRoot !== path.join(smokeRoot, 'outputs')
  ) {
    throw new Error('Validation image smoke paths are not builder-owned')
  }
}

function main() {
  if (process.argv.length !== 6) {
    throw new Error('Validation image smoke arguments are invalid')
  }
  const [manifestPath, snapshotRoot, snapshotPath, outputRoot] =
    process.argv.slice(2).map(value => path.resolve(value))
  assertSmokePaths(snapshotRoot, snapshotPath, outputRoot)
  for (const directory of [snapshotRoot, snapshotPath, outputRoot]) {
    if (!fs.statSync(directory).isDirectory()) {
      throw new Error(`Smoke directory is unavailable: ${directory}`)
    }
  }
  const manifest = loadValidationImageManifest({ manifestPath })
  const registry = new ValidationProfileRegistry({
    nodeImageDigest: manifest.nodeImageDigest,
    playwrightImageDigest: manifest.playwrightImageDigest
  })
  const standardRuntime = new DockerValidationRuntime({
    outputRoot,
    snapshotRoot
  })
  const uiRuntime = new DockerUiValidationRuntime({
    outputRoot,
    snapshotRoot
  })
  const sessionId = randomUUID()
  for (const profileId of E3_VALIDATION_PROFILE_IDS) {
    const runId = randomUUID()
    const request = {
      version: 1,
      runId,
      sessionId,
      candidateSetId: randomUUID(),
      candidateManifestSha256: 'a'.repeat(64),
      snapshotHandle: validationSnapshotHandle(sessionId, runId),
      profileId,
      profileVersion: 1,
      profileSetSha256: registry.sha256,
      requestedAt: Date.now(),
      leaseOwner: 'e3-image-smoke',
      fencingToken: 1
    }
    const plan = compileValidationPlan(request, {
      registry,
      actualRuntimeVersion: E3_VALIDATION_RUNTIME.version
    })
    const runtime = profileId === E3_VALIDATION_PROFILE_ID.PLAYWRIGHT_UI
      ? uiRuntime
      : standardRuntime
    const result = runtime.run(plan, { path: snapshotPath })
    if (result.status !== 'succeeded') {
      throw new Error(
        `Validation image smoke failed for ${profileId}: ` +
        `exit ${result.exitCode}\n` +
        `STDOUT:\n${result.stdout}\n` +
        `STDERR:\n${result.stderr}`
      )
    }
    process.stdout.write(
      `E3_VALIDATION_IMAGE_SMOKE_OK=${profileId}\n`
    )
  }
}

try {
  main()
} catch (error) {
  process.stderr.write(`${error?.stack ?? String(error)}\n`)
  process.exitCode = 1
}
