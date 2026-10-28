import type { KitConnection, ModelBatchParams } from '../host/mountKit'
import type { BridgeEditor } from './kitBridge'

/**
 * The kit's KDM schema as `@kition/sdk` registers it (`src/lib/sdk/kits/`), which a kit whose
 * engine does not describe its own schema needs to answer the object model and to compare and
 * merge a draft; `undefined` for a kit Kition has none registered for.
 */
export async function kitSchema(kitId: string) {
  const [{ kitDescriptor }] = await Promise.all([import('@/lib/sdk/kits'), import('@/lib/sdk/kits/index')])
  return kitDescriptor(kitId)?.schema
}

/**
 * The kit's object model for the agent's query and batch tools (Kit UI protocol section 7a), when
 * it lists `model`, with the kit's registered schema. Only a kit that also lists `draft-model`
 * runs them on the agent's draft.
 */
export function bridgeModel(connection: KitConnection, kitId: string): BridgeEditor['model'] {
  if (!connection.capabilities.includes('model')) return undefined
  return {
    // A draft has the document's schema.
    describe: async () => connection.model.describe(await kitSchema(kitId)),
    batch: async (request, options) => {
      const schema = await kitSchema(kitId)
      const params: ModelBatchParams = { ...request, ...(schema ? { schema } : {}), ...(options?.draft ? { draft: true } : {}) }
      return (await connection.model.batch(params)) as Record<string, unknown>
    },
    onDraft: connection.capabilities.includes('draft') && connection.capabilities.includes('draft-model'),
  }
}
