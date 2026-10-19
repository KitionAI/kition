/**
 * Builds the Document kit's engine (packages/document-kit/src/engine/module.ts) into one ES module,
 * public/engine/kition_document_engine.js, with Loro's WebAssembly beside it (loro_wasm_bg.wasm): a
 * `ts-worker` engine (Kit Standard rule K11) that kit-ui's engine worker loads like a wasm-pack one.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { defineConfig, type Plugin } from 'vite'
import { aliases, dependenciesFromHere, kition, web } from './kition.config.ts'

const out = path.join(web, 'public', 'engine')
const loroWeb = path.dirname(createRequire(path.join(web, 'package.json')).resolve('loro-crdt/web'))

/**
 * Loro's web build finds its WebAssembly beside itself (`new URL(..., import.meta.url)`), which a
 * library build would inline as base64; the engine passes the bytes itself (`initSync`), so the
 * reference goes, and the file is copied beside the module instead.
 */
function loroBeside(): Plugin {
  return {
    name: 'kition-document-loro-beside',
    enforce: 'pre',
    transform(code, id) {
      if (!id.startsWith(loroWeb)) return null
      const reference = "new URL('loro_wasm_bg.wasm', import.meta.url)"
      return code.includes(reference) ? code.replaceAll(reference, 'undefined') : null
    },
    closeBundle() {
      fs.copyFileSync(path.join(loroWeb, 'loro_wasm_bg.wasm'), path.join(out, 'loro_wasm_bg.wasm'))
    },
  }
}

export default defineConfig({
  plugins: [dependenciesFromHere(), loroBeside()],
  resolve: {
    // The engine's KDM uses Loro's web build, which it prepares itself (module.ts).
    alias: [{ find: /^loro-crdt$/, replacement: path.join(loroWeb, 'index.js') }, ...aliases],
  },
  build: {
    outDir: out,
    emptyOutDir: true,
    copyPublicDir: false,
    target: 'es2022',
    minify: true,
    lib: {
      entry: path.join(kition, 'packages/document-kit/src/engine/module.ts'),
      formats: ['es'],
      fileName: () => 'kition_document_engine.js',
    },
  },
})
