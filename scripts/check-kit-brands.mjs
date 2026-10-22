#!/usr/bin/env node
// Fails when a kit's brand color differs from the palette (docs/design.md, Kit colors): the kits
// that live in Kition (packages/*-kit/kit.json) and every kit package installed in public/kits/
// (kit-ui.json, written by scripts/build-kit-ui.sh). Packages that are not installed are skipped.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { kitBrandProblems } from './lib/kitBrands.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const palette = readJson(path.join(root, 'kits/kit-colors.json'))

const manifests = []
for (const dir of fs.readdirSync(path.join(root, 'packages'))) {
  const file = path.join(root, 'packages', dir, 'kit.json')
  if (!fs.existsSync(file)) continue
  const kit = readJson(file)
  manifests.push({ source: `packages/${dir}/kit.json`, kitId: kit.id, brand: kit.ui?.brand })
}
const kitsDir = path.join(root, 'public/kits')
for (const dir of fs.existsSync(kitsDir) ? fs.readdirSync(kitsDir) : []) {
  const file = path.join(kitsDir, dir, 'kit-ui.json')
  if (!fs.existsSync(file)) continue
  const pkg = readJson(file)
  manifests.push({ source: `public/kits/${dir}`, kitId: pkg.kitId, brand: pkg.brand })
}

const problems = kitBrandProblems(palette, manifests)
for (const problem of problems) console.error(problem)
if (problems.length) process.exit(1)
console.log(`kit brands match the palette (${manifests.length} kits)`)
