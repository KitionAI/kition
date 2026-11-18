#!/usr/bin/env node
// Writes a kit package's THIRD_PARTY_NOTICES.txt: the npm packages its editor bundles (as
// scripts/build-kit-editor.mjs recorded them) and the crates its WebAssembly engine links (cargo
// metadata of the kit's workspace for wasm32-unknown-unknown, from the cdylib that builds the
// engine/*_bg.wasm the package ships), each with its licence texts. Fails when a package or
// crate ships no licence text or uses a licence that is not accepted. Run by scripts/build-kit-ui.sh:
//
//   node scripts/kit-package-notices.mjs <kit-repo> <package-dir> <bundled.json>
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { ENGINE_TARGET, engineRootPackages, readBundledPackages, renderKitPackageNotices } from './lib/kitPackageNotices.mjs'
import { linkedCrates, loadMetadata } from './lib/rustCrateNotices.mjs'

const [kitRepo, packageDir, bundledFile] = process.argv.slice(2)
if (!kitRepo || !packageDir || !bundledFile) {
  console.error('usage: node scripts/kit-package-notices.mjs <kit-repo> <package-dir> <bundled.json>')
  process.exit(2)
}
try {
  const manifest = JSON.parse(fs.readFileSync(path.join(kitRepo, 'kit.json'), 'utf8'))
  const engineDir = path.join(packageDir, 'engine')
  const wasmFiles = fs.existsSync(engineDir) ? fs.readdirSync(engineDir).filter((name) => name.endsWith('_bg.wasm')) : []
  if (!wasmFiles.length) throw new Error(`${packageDir} ships no engine/*_bg.wasm`)
  const metadata = loadMetadata(kitRepo, ENGINE_TARGET)
  const crates = new Map()
  for (const root of engineRootPackages(metadata, wasmFiles)) {
    for (const crate of linkedCrates(metadata, root)) crates.set(`${crate.name}\0${crate.version}`, crate)
  }
  const sortedCrates = [...crates.keys()].sort().map((key) => crates.get(key))
  const packages = readBundledPackages(JSON.parse(fs.readFileSync(bundledFile, 'utf8')))
  const text = renderKitPackageNotices({ kitName: manifest.name ?? manifest.id, version: manifest.version, packages, crates: sortedCrates })
  fs.writeFileSync(path.join(packageDir, 'THIRD_PARTY_NOTICES.txt'), text)
  console.log(`[kit-package-notices] ${path.basename(packageDir)}/THIRD_PARTY_NOTICES.txt: ${packages.length} npm packages, ${sortedCrates.length} crates`)
} catch (error) {
  console.error(`[kit-package-notices] ${error instanceof Error ? error.message : error}`)
  process.exit(1)
}
