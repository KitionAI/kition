/**
 * The Document kit's engine module (`engine.runtime` `ts-worker`): built by the kit's
 * `web/vite.engine.config.ts` into `engine/kition_document_engine.js`, with Loro's WebAssembly
 * beside it. A host awaits the default export before the first document (`KitEngineInit`).
 */
import { initSync } from 'loro-crdt/web'
import { kitEngineClass, type KitEngineInit } from '@kition/kit-engine'
import { documentModel } from './documentModel'

const LORO_WASM = 'loro_wasm_bg.wasm'

/** Loads the KDM's WebAssembly (Loro) from this module's folder; the engine runs in a worker. */
export default async function prepare({ base, read }: KitEngineInit) {
  let bytes: Uint8Array
  if (read) bytes = await read(LORO_WASM)
  else {
    const response = await fetch(new URL(LORO_WASM, base))
    if (!response.ok) throw new Error(`the document engine could not load ${LORO_WASM} (HTTP ${response.status})`)
    bytes = new Uint8Array(await response.arrayBuffer())
  }
  initSync({ module: bytes })
}

export const MarkdownDocument = kitEngineClass(documentModel)
