import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'

/** This folder, the Kition checkout it is in, and the kition-sdk checkout beside it (or KITION_SDK). */
export const web = path.dirname(fileURLToPath(import.meta.url))
export const kition = path.resolve(web, '..', '..', '..')
export const sdk = path.resolve(process.env.KITION_SDK ?? path.join(kition, '..', 'kition-sdk'))

/**
 * The packages the kit is built from, by name: Kition's board editor and shared UI (in this
 * checkout), and kition-sdk's Kit Data Model, engine contract, and Kit UI packages.
 */
export const aliases = [
  { find: /^@kition\/app-ui$/, replacement: path.join(kition, 'packages/app-ui/src/index.tsx') },
  { find: /^@kition\/app-ui\//, replacement: `${path.join(kition, 'packages/app-ui/src')}/` },
  { find: /^@kition\/board-editor$/, replacement: path.join(kition, 'packages/board-editor/src/index.ts') },
  { find: /^@kition\/board-editor\//, replacement: `${path.join(kition, 'packages/board-editor/src')}/` },
  { find: /^@kition\/kdm$/, replacement: path.join(sdk, 'packages/kdm/src/index.ts') },
  { find: /^@kition\/kit-engine$/, replacement: path.join(sdk, 'packages/kit-engine/src/index.ts') },
  { find: /^@kition\/kit-ui$/, replacement: path.join(sdk, 'packages/kit-ui/src/index.ts') },
  { find: /^@kition\/kit-ui\/styles\.css$/, replacement: path.join(sdk, 'packages/kit-ui/src/styles.css') },
  { find: /^@kition\/kit-protocol$/, replacement: path.join(sdk, 'packages/kit-protocol/src/index.ts') },
  { find: /^@kition\/kit-host$/, replacement: path.join(sdk, 'packages/kit-host/src/index.ts') },
  { find: /^@kition\/kit-dev-host$/, replacement: path.join(sdk, 'packages/kit-dev-host/src/index.ts') },
]

/**
 * Sources outside this folder (Kition's packages, kition-sdk's) take their npm dependencies from
 * here: a bare import from a file there resolves as if it were made here, so the page and the
 * engine have one React and one Loro, and the build never needs the checkouts' node_modules.
 */
export function dependenciesFromHere(): Plugin {
  const here = path.join(web, 'src', 'main.tsx')
  const inside = (file: string) => file.startsWith(web + path.sep) && !file.includes(`${path.sep}node_modules${path.sep}`)
  return {
    name: 'kition-board-dependencies-from-here',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer || inside(importer) || importer.includes(`${path.sep}node_modules${path.sep}`)) return null
      if (/^[./\0]/.test(source) || source.startsWith('@kition/') || source.startsWith('node:') || path.isAbsolute(source)) return null
      return this.resolve(source, here, { ...options, skipSelf: true })
    },
  }
}
