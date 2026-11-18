import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chooseLicenses, IJG_STATEMENT, linkedCrates, MPL_GIT_SOURCE_STATEMENT, MPL_PATH_SOURCE_STATEMENT, MPL_SOURCE_STATEMENT, renderRustNotices } from './rustCrateNotices.mjs'

const divider = '='.repeat(80)
let registry: string

async function crate(name: string, version: string, license: string | null, files: Record<string, string> = {}, authors: string[] = [], source: string | null = 'registry+https://github.com/rust-lang/crates.io-index') {
  const dir = join(registry, `${name}-${version}`)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'Cargo.toml'), `[package]\nname = "${name}"\n`)
  for (const [file, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, file)), { recursive: true })
    await writeFile(join(dir, file), text)
  }
  return { id: `${name} ${version}`, name, version, license, license_file: null, authors, repository: null, source, manifest_path: join(dir, 'Cargo.toml') }
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

  it('does not call a git or vendored MPL-2.0 crate unmodified, and names what links the crates', async () => {
    const git = 'git+https://github.com/example/gamma?rev=abc#abc'
    const { text } = renderRustNotices([
      await crate('gamma', '3.1.0', 'MPL-2.0', {}, [], git),
      await crate('delta', '0.1.0', 'MPL-2.0', {}, [], null),
    ], divider, 'a kit engine')
    expect(text).toContain(`${MPL_GIT_SOURCE_STATEMENT} https://github.com/example/gamma?rev=abc#abc`)
    expect(text).toContain(MPL_PATH_SOURCE_STATEMENT)
    expect(text).not.toContain(MPL_SOURCE_STATEMENT)
    expect(text).toContain('2 third-party crates are compiled into a kit engine.')
  })

  it('names KitionPkg/loro, not the upstream its manifests name, for the crates built from it', async () => {
    const loro = { ...await crate('loro', '1.16.2', 'MIT', {}, [], 'git+https://github.com/KitionPkg/loro?rev=c0f64d39#c0f64d39'), repository: 'https://github.com/loro-dev/loro/' }
    const other = { ...await crate('epsilon', '0.1.0', 'MIT', {}, [], 'git+https://github.com/example/epsilon?rev=abc#abc'), repository: 'https://github.com/upstream/epsilon' }
    const { text } = renderRustNotices([loro, other], divider)
    expect(text).toContain('loro 1.16.2\nLicense: MIT\nRepository: https://github.com/KitionPkg/loro\n')
    expect(text).toContain('epsilon 0.1.0\nLicense: MIT\nRepository: https://github.com/upstream/epsilon\n')
  })

  it('adds the licence texts a crate keeps elsewhere, and the IJG statement', async () => {
    const { text } = renderRustNotices([
      await crate('jpeg-encoder', '0.6.1', '(MIT OR Apache-2.0) AND IJG', { 'LICENSE-MIT': 'Encoder MIT terms' }),
      await crate('epaint_default_fonts', '0.36.2', '(MIT OR Apache-2.0) AND OFL-1.1 AND Ubuntu-font-1.0', { 'fonts/UFL.txt': 'Ubuntu font terms', 'fonts/OFL.txt': 'OFL terms' }),
    ], divider)
    expect(text).toContain(`License: (MIT OR Apache-2.0) AND IJG\nUsed under: MIT AND IJG\n${IJG_STATEMENT}`)
    expect(text).toContain('Encoder MIT terms')
    expect(text).toContain('Independent JPEG Group License')
    expect(text).toContain('Ubuntu font terms')
    expect(text).toContain('OFL terms')
  })

  it('fails on a GPL crate', async () => {
    const crates = [await crate('alpha', '1.0.0', 'MIT', { LICENSE: 'MIT terms' }), await crate('copyleft', '2.0.0', 'GPL-3.0-only', { COPYING: 'GPL terms' })]
    expect(() => renderRustNotices(crates, divider)).toThrow(/copyleft 2\.0\.0 \(GPL-3\.0-only\)/)
  })
})

describe('linkedCrates', () => {
  it('follows normal dependencies only, and leaves out the workspace\'s own crates but not vendored ones', () => {
    const registryCrate = (name: string) => ({ id: name, name, version: '1.0.0', source: 'registry+https://github.com/rust-lang/crates.io-index' })
    const pathCrate = (name: string) => ({ id: name, name, version: '0.1.0', source: null })
    const metadata = {
      packages: [pathCrate('app'), pathCrate('member'), pathCrate('vendored'), registryCrate('linked'), registryCrate('nested'), registryCrate('dev-only'), registryCrate('build-only')],
      workspace_members: ['app', 'member'],
      resolve: {
        nodes: [
          { id: 'app', deps: [
            { pkg: 'linked', dep_kinds: [{ kind: null }] },
            { pkg: 'member', dep_kinds: [{ kind: null }] },
            { pkg: 'dev-only', dep_kinds: [{ kind: 'dev' }] },
            { pkg: 'build-only', dep_kinds: [{ kind: 'build' }] },
          ] },
          { id: 'member', deps: [{ pkg: 'vendored', dep_kinds: [{ kind: null }] }] },
          { id: 'vendored', deps: [] },
          { id: 'linked', deps: [{ pkg: 'nested', dep_kinds: [{ kind: null }] }] },
          { id: 'nested', deps: [] },
          { id: 'dev-only', deps: [] },
          { id: 'build-only', deps: [] },
        ],
      },
    }
    expect(linkedCrates(metadata, 'app').map((entry) => entry.name).sort()).toEqual(['linked', 'nested', 'vendored'])
  })
})

describe('docs/legal/THIRD_PARTY_NOTICES.txt', () => {
  it('carries the Rust crates the desktop app links, with their licence texts', () => {
    const notices = readFileSync(resolve('docs/legal/THIRD_PARTY_NOTICES.txt'), 'utf8')
    expect(notices).toContain('Rust Crate Inventory')
    expect(notices).toMatch(/^tauri \d+\.\d+\.\d+\nLicense: Apache-2\.0 OR MIT/m)
    expect(notices).toMatch(/^serde \d+\.\d+\.\d+\nLicense: MIT OR Apache-2\.0/m)
    expect(notices).not.toMatch(/^License: .*\bA?GPL-/m)
    expect(notices).toMatch(/^loro 1\.16\.2\nLicense: MIT\nRepository: https:\/\/github\.com\/KitionPkg\/loro\n/m)
    expect(notices).toMatch(/^loro-internal 1\.16\.2\nLicense: MIT\nRepository: https:\/\/github\.com\/KitionPkg\/loro\n/m)
    expect(notices).not.toContain('Repository: https://github.com/loro-dev/loro')
  })
})
