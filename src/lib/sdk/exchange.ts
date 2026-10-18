// Copied from kition-sdk packages/sdk/src/exchange.ts by scripts/sync-kit-host.mjs; change it there, not here.
import {
  BatchError,
  describeModel,
  parseSchema,
  randomActor,
  Replica,
  runBatch,
  type BatchRequest,
  type BatchResult,
  type BatchTarget,
  type Schema,
  type Version,
} from '../kdm'
import type { KitCommandInfo, ModelPort } from './port'

const REFUSED = 'the kit refused the changes'

/** `model/describe`'s answer: the schema, the root's id, and the kit's commands. */
export type ModelDescription = ReturnType<typeof describeModel> & { commands: KitCommandInfo[] }

/**
 * The host's side of the object model over a `ModelPort` (the twin of `kition_sdk::session::model::Exchange`):
 * a scratch replica of the document, caught up with the engine's changes before every read and
 * write. A batch's model operations run on it as transactions whose changes go to the engine; its
 * commands go to the engine between them. Batches run one at a time.
 */
export class Exchange {
  private scratch: Replica | null = null
  private queue: Promise<unknown> = Promise.resolve()
  readonly schema: Schema

  constructor(
    readonly port: ModelPort,
    schema: Schema | object,
  ) {
    this.schema = 'types' in schema && 'root' in schema && 'kit' in schema ? parseSchema(schema) : (schema as Schema)
  }

  /** The scratch replica's version after the last batch, or `null` before the first. */
  version(): Version | null {
    return this.scratch?.version() ?? null
  }

  private async catchUp(): Promise<Replica> {
    if (!this.scratch) {
      const all = await this.port.exportChanges(new Uint8Array(0))
      this.scratch = Replica.load(this.schema, all, randomActor())
    } else {
      const changes = await this.port.exportChanges(this.scratch.version().encode())
      if (changes.byteLength > 0) this.scratch.importChanges(changes)
    }
    return this.scratch
  }

  private target(): BatchTarget {
    return {
      replica: () => this.catchUp(),
      transact: async (origin, write) => {
        const replica = await this.catchUp()
        const before = replica.version()
        replica.transact(origin, write)
        if (replica.version().equals(before)) return
        try {
          await this.port.importChanges(replica.exportChanges(before))
        } catch (error) {
          throw new BatchError('invalid-value', null, `${REFUSED}: ${error instanceof Error ? error.message : String(error)}`)
        }
      },
      command: (id, params, origin) => this.port.command(id, params, origin),
      readOnly: () => this.port.readOnly?.() ?? false,
    }
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work)
    this.queue = next.catch(() => undefined)
    return next
  }

  /** `model/batch`. */
  batch(request: BatchRequest): Promise<BatchResult> {
    return this.serial(async () => {
      try {
        return await runBatch(this.target(), request)
      } catch (error) {
        // The engine has not taken what the scratch replica holds: start again from the engine.
        if (error instanceof BatchError && error.message.startsWith(REFUSED)) this.scratch = null
        throw error
      }
    })
  }

  /** `model/describe`: the schema, the root, and the kit's commands. */
  describe(): Promise<ModelDescription> {
    return this.serial(async () => {
      const commands = await this.port.commands()
      return { ...describeModel(await this.catchUp()), commands }
    })
  }

  /** Forgets the scratch replica (the engine opened another document). */
  reset() {
    this.scratch = null
  }
}
