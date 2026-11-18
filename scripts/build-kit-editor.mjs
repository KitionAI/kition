#!/usr/bin/env node
// Builds a kit's editor the way its `vite build` does (the kit's own vite.config, the Vite its
// web/ app installs), and records the npm packages the bundles contain, workers included, so the
// kit package can carry their notices (scripts/kit-package-notices.mjs). Run from the kit's web/
// folder by scripts/build-kit-ui.sh:
//
//   node <kition>/scripts/build-kit-editor.mjs <bundled.json>
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { recordBundledPackages } from './lib/kitPackageNotices.mjs'

const output = process.argv[2]
if (!output) {
  console.error('usage: node scripts/build-kit-editor.mjs <bundled.json> (from the kit\'s web/ folder)')
  process.exit(2)
}
const web = process.cwd()
const require = createRequire(path.join(web, 'package.json'))
const vite = await import(pathToFileURL(require.resolve('vite')).href)
const dirs = new Set()
await vite.build({
  root: web,
  mode: 'production',
  // Merged with the kit's config: Vite appends these plugins to its own, for the page and for workers.
  plugins: [recordBundledPackages(dirs)],
  worker: { plugins: () => [recordBundledPackages(dirs)] },
})
const relative = [...dirs].map((dir) => fs.realpathSync(dir)).sort()
fs.writeFileSync(output, `${JSON.stringify([...new Set(relative)], null, 2)}\n`)
console.log(`[build-kit-editor] the editor bundles ${new Set(relative).size} npm packages`)
