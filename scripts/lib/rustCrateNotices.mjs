// The Rust half of the third-party notices: every crate a shipped artefact links that is not one
// of the workspace's own crates (crates.io and git crates, and vendored path crates), with the
// licence texts the crate ships. docs/legal/THIRD_PARTY_NOTICES.txt covers the desktop app (the
// `kition-app` package in src-tauri and the runtime crates it pulls in) on every platform a
// release builds; scripts/kit-package-notices.mjs covers a kit's WebAssembly engine.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const licenseTemplatesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'licenses')

/** The package the desktop installers ship (src-tauri/Cargo.toml). */
const SHIPPED_PACKAGE = 'kition-app'

/** The targets .github/workflows/publish-release.yml builds installers for. */
const RELEASE_TARGETS = [
  'aarch64-apple-darwin',
  'x86_64-apple-darwin',
  'x86_64-pc-windows-msvc',
  'x86_64-unknown-linux-gnu',
]

/**
 * Licences a shipped crate may use. A crate passes when its licence expression can be satisfied
 * with these alone; anything else (GPL, AGPL, LGPL, unknown ids) fails the generator.
 */
const ACCEPTED_LICENSES = new Set([
  '0BSD',
  'Apache-2.0',
  'Apache-2.0 WITH LLVM-exception',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BSL-1.0',
  'CC0-1.0',
  'CDLA-Permissive-2.0',
  // The Independent JPEG Group's licence (jpeg-encoder, in the Photo and Vector engines): a
  // binary must say it is based in part on the IJG's work, which those kits' NOTICE does.
  'IJG',
  'ISC',
  'MIT',
  'MIT-0',
  'MPL-2.0',
  'OFL-1.1',
  // Ubuntu Light (epaint_default_fonts, in the Sheet and Slide engines): free to redistribute,
  // with its licence text.
  'Ubuntu-font-1.0',
  'Unicode-3.0',
  'Unicode-DFS-2016',
  'Unlicense',
  'Zlib',
])

/** Which accepted licence an OR expression is used under, best first: MPL-2.0 last, as it has terms of its own. */
const PREFERENCE = [
  'MIT',
  'Apache-2.0',
  'Apache-2.0 WITH LLVM-exception',
  'BSD-3-Clause',
  'BSD-2-Clause',
  'ISC',
  'Zlib',
  'BSL-1.0',
  'Unicode-3.0',
  'Unicode-DFS-2016',
  'MIT-0',
  '0BSD',
  'CC0-1.0',
  'Unlicense',
  'CDLA-Permissive-2.0',
  'IJG',
  'OFL-1.1',
  'Ubuntu-font-1.0',
  'MPL-2.0',
]

/** Canonical texts (scripts/licenses/, from SPDX license-list-data) for crates that ship no licence file. */
const TEMPLATE_LICENSES = ['MIT', 'Apache-2.0', 'BSD-3-Clause', 'Zlib', 'BSL-1.0', 'MPL-2.0', 'IJG']

/**
 * Licence texts a crate keeps outside its root folder (`files`, relative to the crate), or does
 * not ship for one term of its licence (`templates`, from scripts/licenses/).
 */
const CRATE_LICENSE_EXTRAS = {
  epaint_default_fonts: { files: ['fonts/OFL.txt', 'fonts/UFL.txt', 'fonts/Hack-Regular.txt', 'fonts/emoji-icon-font-mit-license.txt'] },
  'jpeg-encoder': { templates: ['IJG'] },
}

/**
 * Git repositories whose crates' manifests still name upstream's repository (KitionPkg/loro is
 * Loro without the MPL-2.0 im): a crate built from one shows that repository instead.
 */
const BUILT_FROM_REPOSITORIES = ['https://github.com/KitionPkg/loro']

/** The statement the IJG licence asks of a binary that includes IJG code. */
export const IJG_STATEMENT = 'This software is based in part on the work of the Independent JPEG Group.'

const LICENSE_FILE = /^(licen[cs]e|copying|copyright|notice|unlicense)(?:[._-].*)?$/i

export const MPL_SOURCE_STATEMENT = 'Source: used unmodified; its source code is available from crates.io at'
/** An MPL-2.0 crate taken from git or vendored: where its source is depends on the artefact's own NOTICE. */
export const MPL_GIT_SOURCE_STATEMENT = 'Source: built from'
export const MPL_PATH_SOURCE_STATEMENT = "Source: vendored in the shipping repository; its NOTICE says where the source code and any modifications are published"

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

/** `MIT/Apache-2.0` and `MPL-2.0+` are older spellings of `MIT OR Apache-2.0` and MPL-2.0 or later. */
function tokenize(expression) {
  return expression
    .replace(/\s*\/\s*/g, ' OR ')
    .replace(/\(/g, ' ( ')
    .replace(/\)/g, ' ) ')
    .split(/\s+/)
    .filter(Boolean)
}

/** Parses an SPDX licence expression into `{ or: [...] }`, `{ and: [...] }` and `{ id }` nodes. */
function parseLicenseExpression(expression) {
  const tokens = tokenize(expression)
  let index = 0
  function primary() {
    const token = tokens[index++]
    if (token === '(') {
      const node = orExpression()
      if (tokens[index++] !== ')') throw new Error(`unbalanced parentheses in "${expression}"`)
      return node
    }
    if (!token || token === ')' || /^(AND|OR|WITH)$/.test(token)) throw new Error(`unexpected "${token ?? 'end'}" in "${expression}"`)
    let id = token.replace(/\+$/, '')
    if (tokens[index] === 'WITH') {
      index += 1
      id = `${id} WITH ${tokens[index++]}`
    }
    return { id }
  }
  function andExpression() {
    const terms = [primary()]
    while (tokens[index] === 'AND') {
      index += 1
      terms.push(primary())
    }
    return terms.length === 1 ? terms[0] : { and: terms }
  }
  function orExpression() {
    const terms = [andExpression()]
    while (tokens[index] === 'OR') {
      index += 1
      terms.push(andExpression())
    }
    return terms.length === 1 ? terms[0] : { or: terms }
  }
  const node = orExpression()
  if (index !== tokens.length) throw new Error(`unexpected "${tokens[index]}" in "${expression}"`)
  return node
}

function rank(ids) {
  return Math.max(...ids.map((id) => PREFERENCE.indexOf(id)))
}

/**
 * The licences a crate is used under: one accepted choice that satisfies its expression, or null
 * when no choice does (a copyleft or unknown licence with no permissive alternative).
 */
export function chooseLicenses(expression) {
  function choose(node) {
    if (node.id) return ACCEPTED_LICENSES.has(node.id) ? [node.id] : null
    if (node.and) {
      const parts = node.and.map(choose)
      return parts.every(Boolean) ? [...new Set(parts.flat())] : null
    }
    const options = node.or.map(choose).filter(Boolean)
    if (!options.length) return null
    return options.reduce((best, option) => (rank(option) < rank(best) ? option : best))
  }
  return choose(parseLicenseExpression(expression))
}

function readTemplate(id, holders) {
  const text = fs.readFileSync(path.join(licenseTemplatesDir, `${id}.txt`), 'utf8')
  return normalizeText(text
    .replace('<year> <copyright holders>', holders)
    .replace('<year> <owner>', holders))
}

function listLicenseFiles(dir) {
  const files = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!LICENSE_FILE.test(entry.name)) continue
    const entryPath = path.join(dir, entry.name)
    if (entry.isFile()) {
      files.push(entryPath)
    } else if (entry.isDirectory()) {
      // REUSE-style `LICENSES/<id>.txt`.
      for (const nested of fs.readdirSync(entryPath, { withFileTypes: true })) {
        if (nested.isFile()) files.push(path.join(entryPath, nested.name))
      }
    }
  }
  return files.sort(compareText)
}

/**
 * The licence texts that travel with a crate: the files it ships in its package, or, for a crate
 * that ships none, the canonical text of each licence it is used under.
 */
function crateLicenseTexts(crate, licenses) {
  const dir = path.dirname(crate.manifest_path)
  const extras = CRATE_LICENSE_EXTRAS[crate.name] ?? {}
  const files = listLicenseFiles(dir)
  if (crate.license_file) files.push(path.resolve(dir, crate.license_file))
  const texts = new Set()
  for (const file of [...files, ...(extras.files ?? []).map((file) => path.join(dir, file))]) {
    if (!fs.existsSync(file)) continue
    const text = normalizeText(fs.readFileSync(file, 'utf8'))
    if (text) texts.add(text)
  }
  const holders = crate.authors?.length
    ? crate.authors.map((author) => author.replace(/\s*<[^>]*>/, '')).join(', ')
    : `The ${crate.name} authors`
  for (const id of extras.templates ?? []) texts.add(readTemplate(id, holders))
  if (texts.size) return [...texts].sort(compareText)
  for (const id of licenses) {
    if (!TEMPLATE_LICENSES.includes(id)) {
      throw new Error(`${crate.name} ${crate.version} ships no licence file and scripts/licenses/ has no ${id} text`)
    }
    texts.add(readTemplate(id, holders))
  }
  return [...texts]
}

export function loadMetadata(repositoryDir, target) {
  const result = spawnSync('cargo', ['metadata', '--format-version', '1', '--locked', '--filter-platform', target], {
    cwd: repositoryDir,
    encoding: 'utf8',
    maxBuffer: 200 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `cargo metadata --filter-platform ${target} failed`)
  }
  return JSON.parse(result.stdout)
}

/**
 * The third-party crates `rootName` links for one target: its normal dependencies, transitively,
 * except the workspace's own crates. Development dependencies never ship and build dependencies
 * run only while compiling.
 */
export function linkedCrates(metadata, rootName = SHIPPED_PACKAGE) {
  const packages = new Map(metadata.packages.map((entry) => [entry.id, entry]))
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]))
  const members = new Set(metadata.workspace_members ?? [])
  const root = metadata.packages.find((entry) => entry.name === rootName && members.has(entry.id))
  if (!root) throw new Error(`cargo metadata has no workspace package ${rootName}`)
  const seen = new Set([root.id])
  const pending = [root.id]
  while (pending.length) {
    const node = nodes.get(pending.pop())
    for (const dependency of node?.deps ?? []) {
      if (!dependency.dep_kinds.some((kind) => kind.kind === null)) continue
      if (seen.has(dependency.pkg)) continue
      seen.add(dependency.pkg)
      pending.push(dependency.pkg)
    }
  }
  return [...seen].filter((id) => !members.has(id)).map((id) => packages.get(id)).filter(Boolean)
}

/** Every crate `rootName` links on `targets`, once per name and version. */
export function loadShippedCrates(repositoryDir, targets = RELEASE_TARGETS, rootName = SHIPPED_PACKAGE) {
  const crates = new Map()
  for (const target of targets) {
    for (const crate of linkedCrates(loadMetadata(repositoryDir, target), rootName)) {
      crates.set(`${crate.name}\0${crate.version}`, crate)
    }
  }
  return [...crates.values()].sort((left, right) => compareText(left.name, right.name) || compareText(left.version, right.version))
}

function crateRepository(crate) {
  const built = crate.source?.startsWith('git+') ? crate.source.slice(4).replace(/[?#].*$/, '') : null
  return BUILT_FROM_REPOSITORIES.includes(built) ? built : crate.repository
}

function mplSourceLine(crate) {
  if (!crate.source) return MPL_PATH_SOURCE_STATEMENT
  if (crate.source.startsWith('git+')) return `${MPL_GIT_SOURCE_STATEMENT} ${crate.source.replace(/^git\+/, '')}`
  return `${MPL_SOURCE_STATEMENT} https://crates.io/crates/${crate.name}/${crate.version}`
}

/**
 * The crates' inventory and licence texts; throws when a crate's licence is not accepted.
 * `subject` names what links them ("the Kition desktop app for <targets>" by default).
 */
export function renderRustNotices(crates, divider, subject = `the Kition desktop app for ${RELEASE_TARGETS.join(', ')}`) {
  const refused = []
  const texts = []
  const textIndexes = new Map()
  const cratesByText = []
  const inventory = []
  const licenseCounts = new Map()
  for (const crate of crates) {
    const expression = crate.license ?? (crate.license_file ? 'LicenseRef-file' : null)
    const licenses = expression && expression !== 'LicenseRef-file' ? chooseLicenses(expression) : null
    if (!licenses) {
      refused.push(`${crate.name} ${crate.version} (${expression ?? 'no licence'})`)
      continue
    }
    for (const id of licenses) licenseCounts.set(id, (licenseCounts.get(id) ?? 0) + 1)
    const label = `${crate.name} ${crate.version}`
    const lines = [label, `License: ${expression}`]
    if (licenses.join(' AND ') !== expression) lines.push(`Used under: ${licenses.join(' AND ')}`)
    const repository = crateRepository(crate)
    if (repository) lines.push(`Repository: ${repository}`)
    if (licenses.includes('MPL-2.0')) lines.push(mplSourceLine(crate))
    if (licenses.includes('IJG')) lines.push(IJG_STATEMENT)
    const indexes = []
    for (const text of crateLicenseTexts(crate, licenses)) {
      let index = textIndexes.get(text)
      if (index === undefined) {
        index = texts.length
        textIndexes.set(text, index)
        texts.push(text)
        cratesByText.push([])
      }
      indexes.push(index + 1)
      cratesByText[index].push(label)
    }
    lines.push(`License text: ${indexes.map((index) => `R${index}`).join(', ')}`, '')
    inventory.push(lines.join('\n'))
  }
  if (refused.length) {
    throw new Error(`crates linked into ${subject} have licences that are not accepted:\n  ${refused.join('\n  ')}`)
  }
  const textSections = texts.map((text, index) => [
    `License text R${index + 1}`,
    `Crates: ${cratesByText[index].join('; ')}`,
    '',
    text,
  ].join('\n'))
  const summary = [...licenseCounts]
    .sort((left, right) => right[1] - left[1] || compareText(left[0], right[0]))
    .map(([id, count]) => `${id}: ${count}`)
  return {
    crateCount: crates.length,
    licenseCounts,
    text: [
      'Rust Crate Inventory',
      '',
      `${crates.length} third-party crates are compiled into ${subject}.`,
      `Licences used: ${summary.join(', ')}.`,
      '',
      inventory.join('\n'),
      divider,
      '',
      'Rust Crate License Texts',
      '',
      textSections.join(`\n\n${divider}\n\n`),
      '',
    ].join('\n'),
  }
}
