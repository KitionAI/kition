import { describe, expect, it, vi } from 'vitest'

import type { KitConnection } from '../host/mountKit'
import { bridgeModel } from './kitBridgeModel'

/** A kit connection whose object model records what Kition asked it. */
function connection(capabilities: string[]) {
  const describe = vi.fn(async (_schema?: object) => ({ kit: 'kit.fig' }))
  const batch = vi.fn(async (_params: unknown) => ({ refs: {}, results: [], loaded: [] }))
  return { connection: { capabilities, model: { describe, batch } } as unknown as KitConnection, describe, batch }
}

// Case: regressions/issue-bridge-model-schema.
describe('bridgeModel', () => {
  it("sends the kit's registered schema with the agent's describe and batch, which a kit whose engine does not describe its own needs (Fig, Vector)", async () => {
    const kit = connection(['model'])
    const model = bridgeModel(kit.connection, 'kit.fig')!
    await model.describe()
    await model.batch({ ops: [], load: [{ target: 'root' }] })
    const [described] = kit.describe.mock.calls[0]!
    expect(described).toMatchObject({ kit: 'kit.fig', schemaVersion: 3, root: 'Fig' })
    expect(kit.batch.mock.calls[0]![0]).toMatchObject({ ops: [], load: [{ target: 'root' }], schema: { kit: 'kit.fig', root: 'Fig' } })
  })

  it("sends no schema for a kit Kition has none registered for, and keeps the agent's draft", async () => {
    const kit = connection(['model', 'draft', 'draft-model'])
    const model = bridgeModel(kit.connection, 'kit.unknown')!
    expect(model.onDraft).toBe(true)
    await model.describe()
    await model.batch({ ops: [], load: [] }, { draft: true })
    expect(kit.describe.mock.calls[0]![0]).toBeUndefined()
    expect(kit.batch.mock.calls[0]![0]).toEqual({ ops: [], load: [], draft: true })
  })

  it('offers no object model for a kit that lists none', () => {
    expect(bridgeModel(connection([]).connection, 'kit.fig')).toBeUndefined()
  })
})
