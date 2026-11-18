import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  bundledPackageDir,
  engineRootPackages,
  readBundledPackages,
  recordBundledPackages,
  renderKitPackageNotices,
} from './kitPackageNotices.mjs'

let scratch: string

async function npmPackage(name: string, version: string, license: string | null, files: Record<string, string>) {
  const dir = join(scratch, 'node_modules', name)
  await mkdir(join(dir, 'dist'), { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name, version, ...(license ? { license } : {}) }))
  for (const [file, text] of Object.entries(files)) await writeFile(join(dir, file), text)
  return dir
}

async function crate(name: string, license: string, files: Record<string, string>) {
  const dir = join(scratch, 'registry', name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'Cargo.toml'), `[package]\nname = "${name}"\n`)
  for (const [file, text] of Object.entries(files)) await writeFile(join(dir, file), text)
  return { id: name, name, version: '1.0.0', license, license_file: null, authors: [], repository: null, source: 'registry+https://github.com/rust-lang/crates.io-index', manifest_path: join(dir, 'Cargo.toml') }
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'kition-kit-notices-'))
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe('bundledPackageDir', () => {
  it('names the package of a bundled module, the innermost one under pnpm, and skips the kit\'s own modules', () => {
    expect(bundledPackageDir('/w/node_modules/.pnpm/react@19.0.0/node_modules/react/index.js')).toBe('/w/node_modules/.pnpm/react@19.0.0/node_modules/react')
    expect(bundledPackageDir('\0/w/node_modules/@kition/kit-editor/dist/index.js?commonjs-proxy')).toBe('/w/node_modules/@kition/kit-editor')
    expect(bundledPackageDir('/w/src/main.tsx')).toBeNull()
    expect(bundledPackageDir('\0vite/preload-helper.js')).toBeNull()
  })

  it('records the packages of every module the bundles list', () => {
    const dirs = new Set<string>()
    const plugin = recordBundledPackages(dirs)
    plugin.generateBundle({}, {
      'index.js': { modules: { '/w/src/main.tsx': {}, '/w/node_modules/react/index.js': {} } },
      'worker.js': { modules: { '/w/node_modules/loro-crdt/web/index.js': {} } },
      'style.css': { source: '' },
    })
    expect([...dirs].sort()).toEqual(['/w/node_modules/loro-crdt', '/w/node_modules/react'])
  })
})

describe('renderKitPackageNotices', () => {
  it('groups the licence and notice files of bundled packages and linked crates', async () => {
    const icons = await npmPackage('@kition/tessera-icons', '0.1.0', 'Apache-2.0', { LICENSE: 'Apache terms', 'LICENSE-lucide': 'ISC terms (Lucide)', NOTICE: 'Lucide notice' })
    const editor = await npmPackage('@kition/kit-editor', '0.1.0', 'Apache-2.0', { 'dist/LICENSE': 'Apache terms', 'dist/THIRD_PARTY_NOTICES': 'Loro MIT terms' })
    const react = await npmPackage('react', '19.0.0', 'MIT', { LICENSE: 'Copyright (c) Meta\r\nMIT terms' })
    const packages = readBundledPackages([react, icons, editor, react])
    const text = renderKitPackageNotices({
      kitName: 'Note',
      version: '0.1.2',
      packages,
      crates: [await crate('alpha', 'MIT OR Apache-2.0', { 'LICENSE-MIT': 'Alpha MIT terms', NOTICE: 'Alpha notice' })],
    })
    expect(text).toContain('Third-Party Notices: the Note kit package 0.1.2')
    expect(text).toContain('3 npm packages are bundled into its editor (assets/).')
    expect(text).toContain('@kition/kit-editor 0.1.0\nLicense: Apache-2.0\nLicense text: N1, N2')
    expect(text).toContain('@kition/tessera-icons 0.1.0\nLicense: Apache-2.0\nLicense text: N1, N3, N4')
    expect(text).toContain('License text N1\nPackages: @kition/kit-editor 0.1.0; @kition/tessera-icons 0.1.0')
    for (const part of ['ISC terms (Lucide)', 'Lucide notice', 'Loro MIT terms', 'Copyright (c) Meta\nMIT terms', 'Alpha MIT terms', 'Alpha notice']) {
      expect(text).toContain(part)
    }
    expect(text).toContain('1 third-party crates are compiled into its WebAssembly engine (wasm32-unknown-unknown).')
  })

  it('takes the upstream text for a package that publishes none, and the elected licence of a dual-licensed one', async () => {
    const fastdom = await npmPackage('fastdom', '1.0.12', 'MIT', {})
    const dompurify = await npmPackage('dompurify', '3.4.17', '(MPL-2.0 OR Apache-2.0)', { LICENSE: 'Apache terms', 'LICENSE-MPL': 'MPL terms' })
    const khroma = await npmPackage('khroma', '2.1.0', null, { license: 'MIT terms' })
    const text = renderKitPackageNotices({ kitName: 'Note', version: '0.1.2', packages: readBundledPackages([fastdom, dompurify, khroma]), crates: [] })
    expect(text).toContain('Copyright (c) 2016 Wilson Page')
    expect(text).toMatch(/^dompurify 3\.4\.17\nLicense: \(MPL-2\.0 OR Apache-2\.0\)\nUsed under: Apache-2\.0\n/m)
    expect(text).not.toContain('MPL terms')
    expect(text).toMatch(/^khroma 2\.1\.0\nLicense: MIT\n/m)
  })

  it('fails when a bundled package ships no licence text', async () => {
    const bare = await npmPackage('bare', '1.0.0', 'MIT', {})
    expect(() => renderKitPackageNotices({ kitName: 'Note', version: '0.1.2', packages: readBundledPackages([bare]), crates: [] }))
      .toThrow(/ship no licence text[^]*bare 1\.0\.0/)
  })

  it('fails on a bundled package under a licence that is not accepted', async () => {
    const copyleft = await npmPackage('copyleft', '2.0.0', 'GPL-3.0-only', { LICENSE: 'GPL terms' })
    expect(() => renderKitPackageNotices({ kitName: 'Note', version: '0.1.2', packages: readBundledPackages([copyleft]), crates: [] }))
      .toThrow(/copyleft 2\.0\.0 \(GPL-3\.0-only\)/)
  })
})

describe('engineRootPackages', () => {
  it('finds the cdylib that builds each shipped engine, and refuses an engine no crate builds', () => {
    const metadata = {
      workspace_members: ['kit', 'core'],
      packages: [
        { id: 'kit', name: 'kition-note-kit', targets: [{ name: 'kition_note_kit', kind: ['cdylib', 'rlib'] }] },
        { id: 'core', name: 'kition-note-core', targets: [{ name: 'kition_note_core', kind: ['lib'] }] },
      ],
    }
    expect(engineRootPackages(metadata, ['kition_note_kit_bg.wasm'])).toEqual(['kition-note-kit'])
    expect(() => engineRootPackages(metadata, ['stale_bg.wasm'])).toThrow(/stale_bg\.wasm/)
  })
})
