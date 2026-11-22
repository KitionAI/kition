#!/usr/bin/env node
// Checks that Kition's own code names no kit. A kit is known to the host by its manifest
// (`kit.json`) and the Kit protocols only: which kits ship is configuration (kits/kits.lock.json),
// and code that names one kit (its id, its own file extension, its engine class or module) is a
// second copy of the manifest that goes stale, or a feature only that kit has.
//
// For every kit name <n> in kits/kits.lock.json the check looks, in src/, src-tauri/src/ and
// crates/*/src/, for:
//
// - the kit id: `kit.<n>` in quotes or backticks;
// - the kit's own extension: the word `k<n>` (`ktable`, `.kfilm`);
// - the engine: `kition_<n>_kit`, and `<N>Document` in quotes (a name such as PdfDocument is
//   also a type of other libraries, so only the string is a kit's engine class).
//
// Tests are not checked (`*.spec.*`, `*.test.*`, `tests.rs`, `*_tests.rs`, folders named `test`,
// `tests`, `__tests__` and `fixtures`, and a Rust file from its `#[cfg(test)]` line on), nor are
// comment lines, the locale files and generated code.
//
// A match fails the check: read the kit's manifest instead (docs/kits.md).
//
//   node scripts/check-kit-neutral.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE = /\.(?:rs|ts|tsx|mts|cts|js|jsx|mjs|cjs)$/
const TEST_FILE = /(?:\.(?:spec|test)\.[a-z]+|(?:^|[/_])tests\.rs)$/
const TEST_FOLDER = /(?:^|\/)(?:tests?|__tests__|fixtures)\//
const SKIPPED = [/^src\/i18n\/locales\//, /^src\/api\/generated\//]
const COMMENT = /^\s*(?:\/\/|\/\*|\*)/

/** The kit names of a kits lock file: its keys, without `$comment`. */
export function kitNames(lock) {
  return Object.keys(lock).filter((name) => /^[a-z][a-z0-9-]*$/.test(name))
}

/** The pattern that finds any of `names` named as a kit. */
export function kitPattern(names) {
  const any = names.join('|')
  const classes = names.map((name) => name[0].toUpperCase() + name.slice(1)).join('|')
  return new RegExp(`['"\`]kit\\.(?:${any})['"\`]|\\bk(?:${any})\\b|\\bkition_(?:${any})_kit\\b|['"\`](?:${classes})Document['"\`]`, 'g')
}

/** Whether the file at the repository-relative `file` is checked. */
export function isChecked(file) {
  return SOURCE.test(file) && !TEST_FILE.test(file) && !TEST_FOLDER.test(file) && !SKIPPED.some((skipped) => skipped.test(file))
}

/** The matches in one file's text: `{ line, text }` per match. */
export function matchesIn(file, text, pattern) {
  const found = []
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (file.endsWith('.rs') && /^\s*#\[cfg\(test\)\]/.test(line)) break
    if (COMMENT.test(line)) continue
    for (const match of line.matchAll(pattern)) found.push({ line: index + 1, text: match[0] })
  }
  return found
}

function sourceFiles(root) {
  const roots = ['src', 'src-tauri/src']
  const crates = path.join(root, 'crates')
  if (fs.existsSync(crates)) {
    for (const crate of fs.readdirSync(crates).sort()) roots.push(`crates/${crate}/src`)
  }
  const files = []
  const walk = (relative) => {
    const entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = `${relative}/${entry.name}`
      if (entry.isDirectory()) walk(child)
      else if (entry.isFile() && isChecked(child)) files.push(child)
    }
  }
  for (const each of roots) {
    if (fs.existsSync(path.join(root, each))) walk(each)
  }
  return files
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const pattern = kitPattern(kitNames(JSON.parse(fs.readFileSync(path.join(root, 'kits/kits.lock.json'), 'utf8'))))
  let found = 0
  for (const file of sourceFiles(root)) {
    for (const match of matchesIn(file, fs.readFileSync(path.join(root, file), 'utf8'), pattern)) {
      found += 1
      console.error(`${file}:${match.line}: ${match.text} names a kit. Read the kit's manifest instead; see docs/kits.md.`)
    }
  }
  if (found) process.exit(1)
  console.log('kit-neutral: ok (no place in Kition\'s own code names a kit)')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
