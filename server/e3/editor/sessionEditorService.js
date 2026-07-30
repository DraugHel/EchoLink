import { randomUUID } from 'node:crypto'
import { E3_SESSION_COMMAND } from '../core/contracts.js'
import { EditorRepository } from '../persistence/editorRepository.js'
import {
  E3_PERSISTENCE_ERROR,
  E3PersistenceError
} from '../persistence/errors.js'
import { E3_EDITOR_ERROR } from './errors.js'
import { E3EditorKernel } from './editorKernel.js'
import {
  OperationIntentRepository,
  editorRequestSha256
} from './operationIntentRepository.js'
import { PreimageStore } from './preimageStore.js'

function fail(message, details = {}) {
  throw new E3PersistenceError(
    E3_PERSISTENCE_ERROR.INVALID_RECORD,
    message,
    details
  )
}

function operationFrom(intent) {
  return {
    id: intent.operationId,
    sessionId: intent.sessionId,
    sequence: intent.sequence,
    type: intent.type,
    pathBefore: intent.pathBefore,
    pathAfter: intent.pathAfter,
    preimageSha256: intent.preimageSha256,
    postimageSha256: intent.postimageSha256,
    parameters: intent.requestMetadata
  }
}

function mutationResult(execution) {
  return execution.result
}

export class SessionEditorService {
  constructor(database, {
    artifactRoot,
    forbiddenRoots = ['/root/echolink'],
    faultInjector = () => {},
    idFactory = randomUUID
  }) {
    this.database = database
    this.sessions = new EditorRepository(database)
    this.intents = new OperationIntentRepository(database)
    this.preimages = new PreimageStore(artifactRoot)
    this.forbiddenRoots = forbiddenRoots
    this.faultInjector = faultInjector
    this.idFactory = idFactory
  }

  #kernel(intent, occurredAt) {
    return new E3EditorKernel({
      workspaceRoot: intent.workspacePath,
      enabled: true,
      forbiddenRoots: this.forbiddenRoots,
      assertLease: () => {
        this.intents.assertIntentOwnership(intent, occurredAt)
      },
      retainPreimage: preimage => {
        const artifact = this.preimages.retain(preimage)
        this.intents.recordPreimage(intent.id, artifact, occurredAt)
        return artifact.storageKey
      }
    })
  }

  #finalize(intent) {
    return this.sessions.recordPreparedOperation(
      intent.command,
      operationFrom(intent),
      intent.id
    )
  }

  mutate({
    sessionId,
    requestId,
    actorId,
    expectedVersion,
    occurredAt,
    sessionOwner,
    sessionFencingToken,
    workspaceOwner,
    workspaceFencingToken,
    request,
    intentId = this.idFactory(),
    operationId = this.idFactory()
  }) {
    const existing = this.intents.getByRequest(sessionId, requestId)
    if (existing) {
      if (existing.requestSha256 !== editorRequestSha256(request)) {
        fail('Request ID is bound to another editor request')
      }
      if (existing.state === 'RECORDED') {
        return Object.freeze({ ...existing.result, replayed: true })
      }
      if (existing.state === 'PUBLISHED') {
        return this.#finalize(existing)
      }
      fail('Prepared operation requires explicit recovery', {
        intentId: existing.id,
        state: existing.state
      })
    }

    const workspace = this.intents.assertCurrentOwnership({
      sessionId,
      sessionOwner,
      sessionFencingToken,
      workspaceOwner,
      workspaceFencingToken,
      occurredAt
    })
    const planningKernel = new E3EditorKernel({
      workspaceRoot: workspace.canonical_path,
      enabled: true,
      forbiddenRoots: this.forbiddenRoots
    })
    const plan = planningKernel.planMutation(request)
    const command = {
      type: E3_SESSION_COMMAND.RECORD_MUTATION,
      sessionId,
      expectedVersion,
      actorId,
      requestId,
      occurredAt,
      leaseOwner: sessionOwner,
      fencingToken: sessionFencingToken
    }
    let intent = this.intents.prepare({
      intentId,
      operationId,
      command,
      request,
      plan,
      sessionOwner,
      sessionFencingToken,
      workspaceOwner,
      workspaceFencingToken
    })
    const result = mutationResult(
      this.#kernel(intent, occurredAt).execute(request)
    )
    this.faultInjector('after_filesystem_publish', { intent, result })
    intent = this.intents.markPublished(intent.id, result, occurredAt)
    this.faultInjector('after_intent_published', { intent, result })
    return this.#finalize(intent)
  }

  recoverMutation({ intentId, request, occurredAt }) {
    let intent = this.intents.get(intentId)
    if (!intent) fail('Operation intent does not exist')
    if (intent.requestSha256 !== editorRequestSha256(request)) {
      fail('Recovery request does not match prepared intent')
    }
    if (intent.state === 'RECORDED') {
      return Object.freeze({ ...intent.result, replayed: true })
    }
    this.intents.assertIntentOwnership(intent, occurredAt)
    if (intent.state === 'PUBLISHED') return this.#finalize(intent)
    if (intent.state !== 'PREPARED') {
      fail('Intent is not recoverable', { state: intent.state })
    }

    const kernel = this.#kernel(intent, occurredAt)
    const observation = this.#observe(kernel, intent)
    if (observation === 'DIVERGED') {
      this.intents.markRecoveryRequired(
        intent.id,
        'Workspace differs from both planned preimage and postimage'
      )
      fail('Workspace requires manual recovery')
    }
    let result
    if (observation === 'PREIMAGE') {
      result = mutationResult(kernel.execute(request))
    } else {
      result = {
        path: intent.pathAfter ?? intent.pathBefore,
        sourcePath: intent.pathBefore,
        destinationPath: intent.pathAfter,
        preimageSha256: intent.preimageSha256,
        postimageSha256: intent.postimageSha256,
        bytes: intent.changedBytes,
        recovered: true
      }
    }
    intent = this.intents.markPublished(intent.id, result, occurredAt)
    return this.#finalize(intent)
  }

  #readHash(kernel, relativePath) {
    if (!relativePath) return null
    try {
      return kernel.execute({
        version: 1,
        type: 'read_file',
        path: relativePath
      }).result.sha256
    } catch (error) {
      if (error?.code === E3_EDITOR_ERROR.FILE_NOT_FOUND) return null
      throw error
    }
  }

  #observe(kernel, intent) {
    const before = this.#readHash(kernel, intent.pathBefore)
    const after = intent.pathAfter === intent.pathBefore
      ? before
      : this.#readHash(kernel, intent.pathAfter)
    const preimage = intent.type === 'create_file'
      ? after === null
      : intent.type === 'rename_file' || intent.type === 'move_file'
        ? before === intent.preimageSha256 && after === null
        : before === intent.preimageSha256
    const postimage = intent.type === 'delete_file'
      ? before === null
      : intent.type === 'rename_file' || intent.type === 'move_file'
        ? before === null && after === intent.postimageSha256
        : after === intent.postimageSha256
    if (postimage) return 'POSTIMAGE'
    if (preimage) return 'PREIMAGE'
    return 'DIVERGED'
  }
}
