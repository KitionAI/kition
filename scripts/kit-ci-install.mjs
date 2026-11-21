#!/usr/bin/env node
// Writes each named kit's .github/workflows/ci.yml, which runs Kition's reusable kit CI
// (.github/workflows/kit-ci.yml) on pushes to ci/** branches (scripts/kit-ci.sh), on pull
// requests, by hand, and nightly on main. The nightly runs start 3 minutes apart in KITS order so
// the kits do not all queue for the organization's concurrent jobs at once.
//
//   node scripts/kit-ci-install.mjs <kit>...   (kit checkouts next to this Kition checkout,
//                                              or under KITION_WORKSPACE)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const KITS = ['board', 'cad', 'design', 'doc', 'film', 'html', 'layout', 'motion', 'note', 'pdf', 'photo', 'scene', 'sheet', 'slide', 'table', 'vector']

export function ciWorkflow(kit) {
  const index = KITS.indexOf(kit)
  if (index < 0) throw new Error(`unknown kit ${kit}; the kits are ${KITS.join(', ')}`)
  const minutes = 18 * 60 + index * 3
  return `name: CI

# Kition's kit CI (KitionAI/kition .github/workflows/kit-ci.yml): the engine build, the Rust
# checks, and every test script as its own job. Written by Kition's scripts/kit-ci-install.mjs.
# Developers push to ci/agent with Kition's scripts/kit-ci.sh and land on main when it passes.

on:
  push:
    branches: ['ci/**']
  pull_request:
  schedule:
    - cron: '${minutes % 60} ${Math.floor(minutes / 60)} * * *'
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: ci-\${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

jobs:
  ci:
    uses: KitionAI/kition/.github/workflows/kit-ci.yml@main
    with:
      kit: ${kit}
`
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const kits = process.argv.slice(2)
  if (!kits.length) {
    console.error('usage: node scripts/kit-ci-install.mjs <kit>...')
    process.exit(2)
  }
  const workspace = process.env.KITION_WORKSPACE ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  for (const kit of kits) {
    const file = path.join(workspace, `kition-${kit}`, '.github', 'workflows', 'ci.yml')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, ciWorkflow(kit))
    console.log(`wrote ${path.relative(workspace, file)}`)
  }
}
