// Copied from kition-sdk packages/sdk/src/kitModel.ts by scripts/sync-kit-host.mjs; change it there, not here.
import { BatchError, parseSchema, type BatchErrorCode, type Schema } from '../kdm'
import type { ModelBackend } from './document'
import type { ModelDescription } from './exchange'
import type { KitModel, ModelPort } from './port'

const CODES: readonly BatchErrorCode[] = ['invalid-op', 'not-found', 'invalid-value', 'read-only', 'command-failed']

/**
 * A kit's refusal of a batch as a `BatchError`: the Kit UI protocol answers it as an error whose
 * `data` is `{ code, index, message }`. Anything else is passed on as it is.
 */
export function batchErrorOf(error: unknown): unknown {
  const data = (error as { data?: { code?: unknown; index?: unknown; message?: unknown } } | null)?.data
  if (!data || typeof data.code !== 'string' || !CODES.includes(data.code as BatchErrorCode)) return error
  const message = typeof data.message === 'string' ? data.message : error instanceof Error ? error.message : String(error)
  return new BatchError(data.code as BatchErrorCode, typeof data.index === 'number' ? data.index : null, message)
}

/**
 * The object model answered by the kit itself (`port.model`, the Kit UI capability `model`): each
 * batch is one `model/batch`, one undo step of the person's history. Batches go one at a time;
 * the kit's `replica/changed` for a batch still running is held until it answers, so this handle
 * knows its own change.
 */
export function kitModelBackend(port: ModelPort & { model: KitModel }, schema: Schema | object): ModelBackend {
  const parsed = 'types' in schema && 'root' in schema && 'kit' in schema ? parseSchema(schema) : (schema as Schema)
  // What crosses to the kit: plain JSON.
  const wire = JSON.parse(JSON.stringify(schema)) as object
  let version: Uint8Array | null = null
  let queue: Promise<unknown> = Promise.resolve()
  let running: Promise<unknown> | null = null
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work)
    queue = next.catch(() => undefined)
    return next
  }
  return {
    kitId: port.kitId,
    schema: parsed,
    batch: (request) =>
      serial(async () => {
        const call = port.model.batch(request, wire)
        running = call.catch(() => undefined)
        try {
          const { version: after, ...result } = await call
          version = after ?? null
          return result
        } catch (error) {
          throw batchErrorOf(error)
        } finally {
          running = null
        }
      }),
    describe: () =>
      serial(async () => {
        try {
          return (await port.model.describe(wire)) as ModelDescription
        } catch (error) {
          throw batchErrorOf(error)
        }
      }),
    commands: () => port.commands(),
    version: () => version,
    onChanged: port.onChanged
      ? (listener) =>
          port.onChanged!((changed) => {
            const waiting = running
            if (waiting) void waiting.then(() => listener(changed))
            else listener(changed)
          })
      : undefined,
  }
}
