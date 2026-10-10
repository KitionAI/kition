/// <reference lib="webworker" />
/**
 * One open kit document in its own worker: the kit's SDK decodes, renders,
 * edits, and encodes here, so the page stays responsive however large the
 * file is, and a failing engine cannot take the page down. Requests are
 * answered in the order they arrive.
 */
import { createKitSdkDocument, kitSdkCommands, loadKitSdk, openKitSdkDocument, type KitSdkDocument } from './kitSdk'
import type { KitEngineInfo, KitEngineRequest, KitEngineResponse } from './kitEngine'
import { lendFiles } from './lentFiles'

declare const self: DedicatedWorkerGlobalScope

let doc: KitSdkDocument | null = null

/** The shared contract's own methods, which `invoke` must not reach around. */
const CONTRACT = new Set(['free', 'execute', 'save', 'markSaved', 'constructor', 'open', 'create'])

function info(open: KitSdkDocument): KitEngineInfo {
  const inspected = JSON.parse(open.inspect()) as Record<string, unknown>
  return {
    width: open.width,
    height: open.height,
    revision: Number(open.revision),
    dirty: open.dirty,
    canUndo: inspected.canUndo === true,
    canRedo: inspected.canRedo === true,
    inspected,
  }
}

function opened() {
  if (!doc) throw new Error('no document is open')
  return doc
}

async function handle(request: KitEngineRequest): Promise<{ value: unknown; transfer?: Transferable[] }> {
  switch (request.method) {
    case 'open': {
      const sdk = await loadKitSdk(request.manifest)
      lendFiles(request.lent)
      doc?.free()
      doc = openKitSdkDocument(sdk, request.manifest, request.name, new Uint8Array(request.bytes))
      return { value: info(doc) }
    }
    case 'create': {
      const sdk = await loadKitSdk(request.manifest)
      lendFiles(request.lent)
      doc?.free()
      doc = createKitSdkDocument(sdk, request.manifest, request.name, request.width, request.height)
      return { value: info(doc) }
    }
    case 'execute': {
      const result = opened().execute(request.command, JSON.stringify(request.params))
      return { value: { result, info: info(opened()) } }
    }
    case 'render': {
      const rgba = opened().render(request.x, request.y, request.scale, request.width, request.height)
      return { value: rgba.buffer, transfer: [rgba.buffer] }
    }
    case 'renderArea': {
      const rgba = opened().renderArea(request.x0, request.y0, request.x1, request.y1, request.width, request.height)
      return { value: rgba.buffer, transfer: [rgba.buffer] }
    }
    case 'commands':
      return { value: kitSdkCommands(opened().commands()) }
    case 'save': {
      const bytes = opened().save()
      return { value: bytes.buffer, transfer: [bytes.buffer] }
    }
    case 'invoke': {
      const open = opened() as unknown as Record<string, unknown>
      const method = open[request.name]
      if (CONTRACT.has(request.name) || request.name.startsWith('_') || typeof method !== 'function') {
        throw new Error(`the kit SDK has no method ${request.name}`)
      }
      const value = (method as (...args: unknown[]) => unknown).apply(open, request.args)
      return ArrayBuffer.isView(value) ? { value, transfer: [value.buffer] } : { value }
    }
    case 'markSaved':
      opened().markSaved()
      return { value: info(opened()) }
  }
}

let queue = Promise.resolve()

self.onmessage = (event: MessageEvent<{ id: number; request: KitEngineRequest }>) => {
  const { id, request } = event.data
  queue = queue.then(async () => {
    try {
      const { value, transfer = [] } = await handle(request)
      self.postMessage({ id, ok: true, value } satisfies KitEngineResponse, transfer)
    } catch (error) {
      self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) } satisfies KitEngineResponse)
    }
  })
}
