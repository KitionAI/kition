/// <reference lib="webworker" />
/**
 * One open image in its own worker: the Photo engine decodes, renders, edits,
 * and encodes here, so the page stays responsive however large the image is.
 * Requests are answered in the order they arrive.
 */
import { inspectPhotoDocument, loadPhotoSdk, photoSdkCommands, type PhotoSdkDocument } from './photoSdk'
import type { PhotoEngineInfo, PhotoEngineRequest, PhotoEngineResponse } from './photoEngine'

declare const self: DedicatedWorkerGlobalScope

let doc: PhotoSdkDocument | null = null

function info(open: PhotoSdkDocument): PhotoEngineInfo {
  return { width: open.width, height: open.height, revision: Number(open.revision), dirty: open.dirty, state: inspectPhotoDocument(open) }
}

function opened() {
  if (!doc) throw new Error('no image is open')
  return doc
}

async function handle(request: PhotoEngineRequest): Promise<{ value: unknown; transfer?: Transferable[] }> {
  switch (request.method) {
    case 'open': {
      const sdk = await loadPhotoSdk()
      doc?.free()
      doc = sdk.PhotoDocument.open(request.name, new Uint8Array(request.bytes))
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
      return { value: photoSdkCommands(opened()) }
    case 'save': {
      const bytes = opened().save()
      return { value: bytes.buffer, transfer: [bytes.buffer] }
    }
    case 'markSaved':
      opened().markSaved()
      return { value: info(opened()) }
  }
}

let queue = Promise.resolve()

self.onmessage = (event: MessageEvent<{ id: number; request: PhotoEngineRequest }>) => {
  const { id, request } = event.data
  queue = queue.then(async () => {
    try {
      const { value, transfer = [] } = await handle(request)
      self.postMessage({ id, ok: true, value } satisfies PhotoEngineResponse, transfer)
    } catch (error) {
      self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) } satisfies PhotoEngineResponse)
    }
  })
}
