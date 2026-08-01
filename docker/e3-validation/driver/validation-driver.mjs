#!/usr/bin/env node
import { validateDriverInvocation } from './lib/contracts.mjs'
import { runValidationProfile } from './lib/profiles.mjs'

async function main() {
  if (process.argv.length !== 3) {
    throw new Error('E3 validation driver requires exactly one profile ID')
  }
  const context = validateDriverInvocation(process.argv[2], process.env)
  await runValidationProfile(context)
}

main().catch(error => {
  process.stderr.write(
    `E3_VALIDATION_DRIVER_FAILED: ${error?.stack ?? String(error)}\n`
  )
  process.exitCode = 1
})
