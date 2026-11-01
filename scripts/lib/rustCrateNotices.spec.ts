import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chooseLicenses, linkedCrates, MPL_SOURCE_STATEMENT, renderRustNotices } from './rustCrateNotices.mjs'

const divider = '='.repeat(80)
let registry: string

async function crate(name: string, version: string, license: string | null, files: Record<string, string> = {}, authors: string[] = []) {
  const dir = join(registry, `${name}-${version}`)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'Cargo.toml'), `[package]\nname = "${name}"\n`)
  for (const [file, text] of Object.entries(files)) await writeFile(join(dir, file), text)
  return { id: `${name} ${version}`, name, version, license, license_file: null, authors, repository: null, source: 'registry+https://github.com/rust-lang/crates.io-index', manifest_path: join(dir, 'Cargo.toml') }
}

beforeEach(async () => {
  registry = await mkdtemp(join(tmpdir(), 'kition-crate-notices-'))
})

afterEach(async () => {
  await rm(registry, { recursive: true, force: true })
})

describe('chooseLicenses', () => {
  it('picks one accepted licence from an OR expression and keeps every AND term', () => {
    expect(chooseLicenses('MIT OR Apache-2.0')).toEqual(['MIT'])
    expect(chooseLicenses('MIT/Apache-2.0')).toEqual(['MIT'])
    expect(chooseLicenses('Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT')).toEqual(['MIT'])
    expect(chooseLicenses('(MIT OR Apache-2.0) AND Unicode-3.0')).toEqual(['MIT', 'Unicode-3.0'])
    expect(chooseLicenses('MPL-2.0+')).toEqual(['MPL-2.0'])
    expect(chooseLicenses('GPL-3.0-or-later OR MIT')).toEqual(['MIT'])
  })

  it('refuses copyleft licences that have no permissive alternative', () => {
    expect(chooseLicenses('GPL-3.0-only')).toBeNull()
    expect(chooseLicenses('AGPL-3.0-or-later')).toBeNull()
    expect(chooseLicenses('MIT AND LGPL-2.1-only')).toBeNull()
  })
})

describe('renderRustNotices', () => {
  it("lists each crate with the licence texts it ships, and canonical texts for crates that ship none", async () => {
    const crates = [
      await crate('alpha', '1.0.0', 'MIT OR Apache-2.0', { 'LICENSE-MIT': 'Copyright (c) Alpha Authors\r\nMIT terms', 'LICENSE-APACHE': 'Apache terms' }),
      await crate('beta', '0.2.0', 'MIT', {}, ['Beta Person <beta@example.com>']),
    ]
    const { text, crateCount } = renderRustNotices(crates, divider)
    expect(crateCount).toBe(2)
    expect(text).toContain('alpha 1.0.0\nLicense: MIT OR Apache-2.0\nUsed under: MIT\nLicense text: R1, R2')
    expect(text).toContain('Copyright (c) Alpha Authors\nMIT terms')
    expect(text).toContain('Apache terms')
    expect(text).toContain('Copyright (c) Beta Person\n\nPermission is hereby granted')
  })

  it('states where the unmodified source of an MPL-2.0 crate is', async () => {
    const { text } = renderRustNotices([await crate('gamma', '3.1.0', 'MPL-2.0')], divider)
    expect(text).toContain(`${MPL_SOURCE_STATEMENT} https://crates.io/crates/gamma/3.1.0`)
    expect(text).toContain('Mozilla Public License Version 2.0')
  })

  it('fails on a GPL crate', async () => {
    const crates = [await crate('alpha', '1.0.0', 'MIT', { LICENSE: 'MIT terms' }), await crate('copyleft', '2.0.0', 'GPL-3.0-only', { COPYING: 'GPL terms' })]
    expect(() => renderRustNotices(crates, divider)).toThrow(/copyleft 2\.0\.0 \(GPL-3\.0-only\)/)
  })
})

describe('linkedCrates', () => {
  it('follows normal dependencies only', () => {
    const registryCrate = (name: string) => ({ id: name, name, version: '1.0.0', source: 'registry+https://github.com/rust-lang/crates.io-index' })
    const metadata = {
      packages: [{ id: 'app', name: 'kition-app', version: '0.0.0', source: null }, registryCrate('linked'), registryCrate('nested'), registryCrate('dev-only'), registryCrate('build-only')],
      resolve: {
        nodes: [
          { id: 'app', deps: [
            { pkg: 'linked', dep_kinds: [{ kind: null }] },
            { pkg: 'dev-only', dep_kinds: [{ kind: 'dev' }] },
            { pkg: 'build-only', dep_kinds: [{ kind: 'build' }] },
          ] },
          { id: 'linked', deps: [{ pkg: 'nested', dep_kinds: [{ kind: null }] }] },
          { id: 'nested', deps: [] },
          { id: 'dev-only', deps: [] },
          { id: 'build-only', deps: [] },
        ],
      },
    }
    expect(linkedCrates(metadata).map((entry) => entry.name).sort()).toEqual(['linked', 'nested'])
  })
})

describe('docs/legal/THIRD_PARTY_NOTICES.txt', () => {
  it('carries the Rust crates the desktop app links, with their licence texts', () => {
    const notices = readFileSync(resolve('docs/legal/THIRD_PARTY_NOTICES.txt'), 'utf8')
    expect(notices).toContain('Rust Crate Inventory')
    expect(notices).toMatch(/^tauri \d+\.\d+\.\d+\nLicense: Apache-2\.0 OR MIT/m)
    expect(notices).toMatch(/^serde \d+\.\d+\.\d+\nLicense: MIT OR Apache-2\.0/m)
    expect(notices).not.toMatch(/^License: .*\bA?GPL-/m)
  })
})
