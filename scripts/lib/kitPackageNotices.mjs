// A kit package's THIRD_PARTY_NOTICES.txt (public/kits/<kit>-ui/): the npm packages the kit's
// editor bundles, as its Vite build recorded them (scripts/build-kit-editor.mjs), and the crates
// its WebAssembly engine links, each with the licence texts it ships. The package's own LICENSE
// and NOTICE cover the kit's code and the assets it credits; this file covers everything the
// build pulled in, so the package stays self-contained (platform rule UI-K1) when another
// application embeds it.
import fs from 'node:fs'
import path from 'node:path'
import { npmLicenseOverride, overrideLicenseText } from './npmLicenseOverrides.mjs'
import { chooseLicenses, renderRustNotices } from './rustCrateNotices.mjs'

/** The target a kit engine is compiled for. */
export const ENGINE_TARGET = 'wasm32-unknown-unknown'

/** Files that carry a package's licence and notices: LICENSE*, LICENCE*, COPYING*, NOTICE*, THIRD_PARTY*. */
const NOTICE_FILE = /^(?:licen[cs]e|copying|notice|third[-_]party[-_]notices)(?:[._-].*)?$/i

function compareText(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function normalizeText(text) {
  return text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim()
}

/**
 * The directory of the npm package a bundled module comes from, or null for the kit's own
 * modules and Vite's virtual ones. pnpm nests packages, so the last node_modules segment wins.
 */
export function bundledPackageDir(moduleId) {
  const match = /^(.*[\\/]node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/.exec(moduleId.replace(/^\0/, ''))
  return match ? match[1].replace(/\\/g, '/') : null
}

/**
 * A Vite (Rollup or Rolldown) plugin that adds to `dirs` the package directory of every module
 * in the bundles it writes. Kept out of tree-shaking's judgement on purpose: a module listed in a
 * chunk is counted even when none of its code survived, which can only add a notice.
 */
export function recordBundledPackages(dirs) {
  return {
    name: 'kition-bundled-packages',
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        for (const id of Object.keys(output.modules ?? {})) {
          const dir = bundledPackageDir(id)
          if (dir) dirs.add(dir)
        }
      }
    },
  }
}

function noticeFiles(dir) {
  const files = []
  // The package root, and dist/ (where packages built from a monorepo keep LICENSE and the
  // THIRD_PARTY_NOTICES of what they bundle in turn).
  for (const folder of [dir, path.join(dir, 'dist')]) {
    if (!fs.existsSync(folder)) continue
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.isFile() && NOTICE_FILE.test(entry.name)) files.push(path.join(folder, entry.name))
    }
  }
  return files.sort(compareText)
}

/** One bundled npm package: its identity and the texts of the licence and notice files it ships (or of its override). */
function readBundledPackage(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const repository = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url
  const override = npmLicenseOverride(manifest.name)
  const files = noticeFiles(dir).filter((file) => !override?.files || override.files.includes(path.basename(file)))
  const texts = []
  for (const file of files) {
    const text = normalizeText(fs.readFileSync(file, 'utf8'))
    if (text && !texts.includes(text)) texts.push(text)
  }
  const supplied = texts.length ? null : overrideLicenseText(override)
  if (supplied) texts.push(normalizeText(supplied))
  return {
    name: manifest.name,
    version: manifest.version,
    license: override?.license ?? (typeof manifest.license === 'string' ? manifest.license : manifest.license?.type ?? null),
    usedUnder: override?.usedUnder ?? null,
    note: override?.note ?? null,
    repository: repository?.replace(/^git\+/, '').replace(/\.git$/, '') ?? manifest.homepage ?? null,
    texts,
  }
}

/** The npm half: inventory and grouped texts. Throws for a package that ships no licence text. */
function renderNpmNotices(packages, divider, subject) {
  const missing = packages.filter((entry) => !entry.texts.length).map((entry) => `${entry.name} ${entry.version}`)
  if (missing.length) {
    throw new Error(`${subject} bundles npm packages that ship no licence text; add the text or drop the package:\n  ${missing.join('\n  ')}`)
  }
  const refused = packages
    .filter((entry) => entry.license && !/^SEE LICEN[CS]E IN /i.test(entry.license))
    .filter((entry) => {
      try {
        return !chooseLicenses(entry.usedUnder ?? entry.license)
      } catch {
        return true
      }
    })
    .map((entry) => `${entry.name} ${entry.version} (${entry.license})`)
  if (refused.length) {
    throw new Error(`${subject} bundles npm packages whose licences are not accepted:\n  ${refused.join('\n  ')}`)
  }
  const texts = []
  const textIndexes = new Map()
  const packagesByText = []
  const inventory = []
  for (const entry of packages) {
    const label = `${entry.name} ${entry.version}`
    const lines = [label, `License: ${entry.license ?? 'see the license text'}`]
    if (entry.usedUnder) lines.push(`Used under: ${entry.usedUnder}`)
    if (entry.note) lines.push(`Note: ${entry.note}`)
    if (entry.repository) lines.push(`Repository: ${entry.repository}`)
    const indexes = []
    for (const text of entry.texts) {
      let index = textIndexes.get(text)
      if (index === undefined) {
        index = texts.length
        textIndexes.set(text, index)
        texts.push(text)
        packagesByText.push([])
      }
      indexes.push(`N${index + 1}`)
      packagesByText[index].push(label)
    }
    lines.push(`License text: ${indexes.join(', ')}`, '')
    inventory.push(lines.join('\n'))
  }
  const textSections = texts.map((text, index) => [
    `License text N${index + 1}`,
    `Packages: ${packagesByText[index].join('; ')}`,
    '',
    text,
  ].join('\n'))
  return [
    'npm Package Inventory',
    '',
    `${packages.length} npm packages are bundled into ${subject}.`,
    '',
    inventory.join('\n'),
    divider,
    '',
    'npm Package License Texts',
    '',
    textSections.join(`\n\n${divider}\n\n`),
    '',
  ].join('\n')
}

/** The bundled packages, one per name and version, in a stable order. */
export function readBundledPackages(dirs) {
  const packages = new Map()
  for (const dir of dirs) {
    const entry = readBundledPackage(dir)
    const key = `${entry.name}\0${entry.version}`
    const known = packages.get(key)
    if (known) {
      for (const text of entry.texts) if (!known.texts.includes(text)) known.texts.push(text)
    } else {
      packages.set(key, entry)
    }
  }
  return [...packages.values()].sort((left, right) => compareText(left.name, right.name) || compareText(left.version, right.version))
}

/**
 * The workspace package that builds a kit's engine: the cdylib whose library name is the stem of
 * a `<name>_bg.wasm` the package ships (wasm-bindgen's output name).
 */
export function engineRootPackages(metadata, wasmFiles) {
  const members = new Set(metadata.workspace_members ?? [])
  const byLib = new Map()
  for (const entry of metadata.packages) {
    if (!members.has(entry.id)) continue
    for (const target of entry.targets ?? []) {
      if (target.kind?.includes('cdylib')) byLib.set(target.name.replace(/-/g, '_'), entry.name)
    }
  }
  return wasmFiles.map((file) => {
    const stem = path.basename(file).replace(/_bg\.wasm$/, '')
    const name = byLib.get(stem)
    if (!name) throw new Error(`the package ships ${path.basename(file)}, which no cdylib crate of the kit's workspace builds`)
    return name
  })
}

/** The whole THIRD_PARTY_NOTICES.txt of a kit package. */
export function renderKitPackageNotices({ kitName, version, packages, crates }) {
  const divider = '='.repeat(80)
  const subject = `the ${kitName} kit package ${version}`
  const rust = renderRustNotices(crates, divider, `its WebAssembly engine (${ENGINE_TARGET})`)
  return [
    `Third-Party Notices: ${subject}`,
    '',
    'This package includes code from the npm packages and Rust crates below, each under its own',
    'license. The editor (index.html and assets/) bundles the npm packages; the engine (engine/)',
    'links the Rust crates. The package\'s LICENSE and NOTICE cover the kit itself and the assets',
    'it credits.',
    '',
    divider,
    '',
    renderNpmNotices(packages, divider, `its editor (assets/)`),
    divider,
    '',
    rust.text,
  ].join('\n')
}
