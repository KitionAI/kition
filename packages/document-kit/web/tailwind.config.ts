import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Config } from 'tailwindcss'
// Kition's theme, copied from the checkout this kit is in by scripts/sync-kition.mjs.
import kitionTheme from './kition/tailwind.config.ts'

const web = path.dirname(fileURLToPath(import.meta.url))
const packages = path.resolve(web, '..', '..')

/** Kition's Tailwind theme over the document editor's source, the shared UI's, and this editor's own. */
export default {
  ...kitionTheme,
  content: {
    relative: false,
    files: [path.join(packages, 'document-editor/src/**/*.{ts,tsx}'), path.join(packages, 'app-ui/src/**/*.{ts,tsx}'), path.join(web, 'src/**/*.{ts,tsx}')],
  },
} satisfies Config
