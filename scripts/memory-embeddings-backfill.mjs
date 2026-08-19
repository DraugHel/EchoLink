#!/usr/bin/env node
import '../server/loadEnv.js'
import {
  backfillMemoryEmbeddings,
  memoryEmbeddingConfig
} from '../server/lib/memoryEmbeddings.js'

const args = new Set(process.argv.slice(2))
const force = args.has('--force')
const config = memoryEmbeddingConfig()

if (!config.enabled) {
  console.error('MEMORY_EMBEDDINGS_ENABLED=false')
  process.exitCode = 1
} else {
  console.log(`MEMORY_EMBEDDING_MODEL=${config.model}`)
  console.log(`MEMORY_EMBEDDING_DIMENSIONS=${config.dimensions}`)
  console.log(`MEMORY_EMBEDDING_FORCE=${force ? 1 : 0}`)

  const result = await backfillMemoryEmbeddings({
    force,
    onProgress(progress) {
      console.log(
        `MEMORY_EMBEDDING_PROGRESS=${progress.processed}/${progress.total}` +
        ` INDEXED=${progress.indexed}` +
        ` SKIPPED=${progress.skipped}` +
        ` REASON=${progress.reason}`
      )
    }
  })

  console.log(`MEMORY_EMBEDDING_TOTAL=${result.total}`)
  console.log(`MEMORY_EMBEDDING_INDEXED=${result.indexed}`)
  console.log(`MEMORY_EMBEDDING_SKIPPED=${result.skipped}`)
  console.log(`MEMORY_EMBEDDING_RESULT=${result.ok ? 'SUCCESS' : 'FAILED'}`)

  if (!result.ok) {
    if (result.error) {
      console.error(`MEMORY_EMBEDDING_ERROR=${result.error}`)
    }
    process.exitCode = 1
  }
}

