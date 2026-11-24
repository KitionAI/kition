import { afterEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  readDocumentIndex: vi.fn(),
  readDocumentStore: vi.fn(),
  findKitCheckpoint: vi.fn(),
  listKitCheckpoints: vi.fn(),
  updateKitCheckpoint: vi.fn(),
  deleteKitCheckpoint: vi.fn(),
  readKitCheckpoint: vi.fn(),
  readViewState: vi.fn(),
  writeViewState: vi.fn(),
  servesKitCheckpoints: vi.fn(() => true),
  servesViewState: vi.fn(() => true),
}))
const writeKitReplica = vi.hoisted(() => vi.fn())
vi.mock('./kitionHost', () => ({ writeKitReplica }))
const bindDocumentId = vi.hoisted(() => vi.fn())
vi.mock('@/services/desktop', () => store)
vi.mock('@/lib/docstore/documentIndex', () => ({ bindDocumentId }))

import { KitRpcError } from '@kition/sdk/protocol'
import { KITION_CHECKPOINTS, KITION_VIEW_STATE, kitHistoryHandlers, kitStoreError, replicaWriteCheckpoint } from './kitCheckpoints'

const DOC = '0199c2a4-7b3e-7cde-8f00-1234567890ab'
const checkpoint = { id: 'c1', time: 1, origin: 'kit', label: 'Draft', version: 'AQI=', available: true }

function reason(error: unknown) {
  return error instanceof KitRpcError ? (error.data as { reason?: string } | undefined)?.reason : undefined
}

afterEach(() => {
  for (const mock of Object.values(store)) mock.mockReset()
  store.servesKitCheckpoints.mockImplementation(() => true)
  store.servesViewState.mockImplementation(() => true)
  bindDocumentId.mockReset()
  writeKitReplica.mockReset()
})

describe('kit checkpoints over the document store', () => {
  it("passes the store's refusals on as the protocol's reasons", () => {
    const cases = [
      ['DOCUMENT_CHECKPOINT_NOT_FOUND', 'not-found'],
      ['DOCUMENT_CHECKPOINT_HISTORY_MISSING', 'history-missing'],
      ['DOCUMENT_CHECKPOINT_TOO_LONG', 'too-long'],
      ['DOCUMENT_CHECKPOINT_READ_ONLY', 'read-only'],
      ['DOCUMENT_STORE_READ_ONLY', 'read-only'],
      ['VIEW_STATE_TOO_LARGE', 'too-large'],
    ]
    for (const [code, expected] of cases) expect(reason(kitStoreError(new Error(code)))).toBe(expected)
    const other = new Error('disk full')
    expect(kitStoreError(other)).toBe(other)
  })

  it("lists, finds, updates and deletes a document's checkpoints by its id", async () => {
    store.readDocumentIndex.mockResolvedValue({ entries: { 'a.kdesign': DOC }, version: 'v' })
    store.listKitCheckpoints.mockResolvedValue({ checkpoints: [checkpoint], more: true })
    await expect(KITION_CHECKPOINTS.list({ path: 'a.kdesign', labelled: true, limit: 1 })).resolves.toEqual({ checkpoints: [checkpoint], more: true })
    expect(store.listKitCheckpoints).toHaveBeenCalledWith(DOC, { labelled: true, limit: 1 })
    store.findKitCheckpoint.mockResolvedValue(checkpoint)
    await expect(KITION_CHECKPOINTS.find({ path: 'a.kdesign', id: 'c1' })).resolves.toEqual(checkpoint)
    store.updateKitCheckpoint.mockResolvedValue({ ...checkpoint, label: 'Final' })
    await expect(KITION_CHECKPOINTS.update({ path: 'a.kdesign', id: 'c1', label: 'Final' })).resolves.toEqual({ checkpoint: { ...checkpoint, label: 'Final' } })
    expect(store.updateKitCheckpoint).toHaveBeenCalledWith(DOC, 'c1', { label: 'Final' })
    store.deleteKitCheckpoint.mockRejectedValueOnce(new Error('DOCUMENT_CHECKPOINT_READ_ONLY'))
    expect(reason(await KITION_CHECKPOINTS.delete({ path: 'a.kdesign', id: 'c1' }).catch((error: unknown) => error))).toBe('read-only')
  })

  it('knows no checkpoint of a document the store does not hold', async () => {
    store.readDocumentIndex.mockResolvedValue({ entries: {}, version: null })
    await expect(KITION_CHECKPOINTS.list({ path: 'new.kdesign' })).resolves.toEqual({ checkpoints: [], more: false })
    await expect(KITION_CHECKPOINTS.find({ path: 'new.kdesign', id: 'c1' })).resolves.toBeNull()
    expect(reason(await KITION_CHECKPOINTS.list({ path: 'new.kdesign', before: 'c1' }).catch((error: unknown) => error))).toBe('not-found')
    expect(reason(await KITION_CHECKPOINTS.read({ path: 'new.kdesign', id: 'c1' }).catch((error: unknown) => error))).toBe('not-found')
    expect(store.listKitCheckpoints).not.toHaveBeenCalled()
  })

  it('reads the blobs of a checkpoint, and refuses a state the stored replica does not reach', async () => {
    store.readDocumentIndex.mockResolvedValue({ entries: { 'a.kdesign': DOC }, version: 'v' })
    store.readKitCheckpoint.mockResolvedValue({ checkpoint, blobs: new Uint8Array([7]) })
    const read = await KITION_CHECKPOINTS.read({ path: 'a.kdesign', id: 'c1' })
    expect(new Uint8Array(read.blobs)).toEqual(new Uint8Array([7]))
    expect(read).not.toHaveProperty('snapshot')
    store.readDocumentStore.mockResolvedValue(null)
    expect(reason(await KITION_CHECKPOINTS.read({ path: 'a.kdesign', id: 'c1', state: true }).catch((error: unknown) => error))).toBe('history-missing')
  })

  it('records the kit checkpoint a replica write asks for, the host save otherwise', () => {
    expect(replicaWriteCheckpoint({ label: 'Draft', description: 'For review' }, 'person')).toEqual({ origin: 'kit', author: 'user:local', label: 'Draft', description: 'For review' })
    expect(replicaWriteCheckpoint(undefined, 'agent')).toEqual({ origin: 'agent', author: 'agent:kition' })
    expect(replicaWriteCheckpoint(undefined, 'person')).toEqual({ origin: 'save', author: 'user:local' })
  })
})

describe('kit view state over the app data', () => {
  it('reads and writes it under the document id, and deletes it with null', async () => {
    store.readDocumentIndex.mockResolvedValue({ entries: { 'a.kdesign': DOC }, version: 'v' })
    store.readViewState.mockResolvedValue({ state: { v: 1 }, bytes: new Uint8Array([1, 2]) })
    const read = await KITION_VIEW_STATE.read({ path: 'a.kdesign' })
    expect(read.state).toEqual({ v: 1 })
    expect(new Uint8Array(read.bytes ?? new ArrayBuffer(0))).toEqual(new Uint8Array([1, 2]))

    bindDocumentId.mockResolvedValue(DOC)
    await KITION_VIEW_STATE.write({ path: 'a.kdesign', state: { v: 2 } })
    expect(store.writeViewState).toHaveBeenCalledWith(DOC, { v: 2 }, undefined)
    await KITION_VIEW_STATE.write({ path: 'a.kdesign', state: null })
    expect(store.writeViewState).toHaveBeenLastCalledWith(DOC, null, undefined)
    expect(bindDocumentId).toHaveBeenCalledTimes(1)

    store.writeViewState.mockRejectedValueOnce(new Error('VIEW_STATE_TOO_LARGE'))
    expect(reason(await KITION_VIEW_STATE.write({ path: 'a.kdesign', state: { v: 3 } }).catch((error: unknown) => error))).toBe('too-large')
  })

  it('reads none for a document the store does not know, and deletes nothing', async () => {
    store.readDocumentIndex.mockResolvedValue({ entries: {}, version: null })
    await expect(KITION_VIEW_STATE.read({ path: 'b.kdesign' })).resolves.toEqual({ state: null })
    await KITION_VIEW_STATE.write({ path: 'b.kdesign', state: null })
    expect(store.writeViewState).not.toHaveBeenCalled()
  })
})

describe("the kit editor's history handlers", () => {
  const checkPath = (wanted: string, path: string) => {
    if (wanted !== path) throw new Error(`${wanted} is not this editor's document`)
    return wanted
  }
  const replica = { snapshot: new ArrayBuffer(1), blobs: new ArrayBuffer(0), fileStamp: 's', version: new Uint8Array([1, 2]).buffer }

  it('records the checkpoint a replica write asks for and answers it', async () => {
    const handlers = kitHistoryHandlers({ path: 'a.kdesign', kitId: 'kit.design', preview: false, lastBy: () => 'person', checkPath })
    writeKitReplica.mockResolvedValue({ checkpoint })
    await expect(handlers.replicaWrite?.({ path: 'a.kdesign', ...replica, checkpoint: { origin: 'kit', label: 'Draft' } })).resolves.toEqual({ checkpoint })
    expect(writeKitReplica).toHaveBeenCalledWith('a.kdesign', 'kit.design', replica, { checkpoint: { origin: 'kit', author: 'user:local', label: 'Draft' } })
    await handlers.replicaWrite?.({ path: 'a.kdesign', ...replica })
    expect(writeKitReplica).toHaveBeenLastCalledWith('a.kdesign', 'kit.design', replica, { checkpoint: { origin: 'save', author: 'user:local' } })
  })

  it("serves only this editor's document", async () => {
    const handlers = kitHistoryHandlers({ path: 'a.kdesign', kitId: 'kit.design', preview: false, lastBy: () => 'agent', checkPath })
    expect(() => handlers.checkpoints?.list({ path: 'other.kdesign' })).toThrow(/not this editor's document/)
    expect(() => handlers.viewState?.read({ path: 'other.kdesign' })).toThrow(/not this editor's document/)
    store.readDocumentIndex.mockResolvedValue({ entries: {}, version: null })
    await expect(handlers.viewState?.read({ path: 'a.kdesign' })).resolves.toEqual({ state: null })
  })

  it('offers a preview, or a page without the desktop shell, neither checkpoints nor view state', async () => {
    const preview = kitHistoryHandlers({ path: 'a.kdesign', kitId: 'kit.design', preview: true, lastBy: () => 'person', checkPath })
    expect(preview.checkpoints).toBeUndefined()
    expect(preview.viewState).toBeUndefined()
    await expect(preview.replicaWrite?.({ path: 'a.kdesign', ...replica })).resolves.toEqual({})
    expect(writeKitReplica).not.toHaveBeenCalled()
    store.servesKitCheckpoints.mockImplementation(() => false)
    store.servesViewState.mockImplementation(() => false)
    const browser = kitHistoryHandlers({ path: 'a.kdesign', kitId: 'kit.design', preview: false, lastBy: () => 'person', checkPath })
    expect(browser.checkpoints).toBeUndefined()
    expect(browser.viewState).toBeUndefined()
  })
})
