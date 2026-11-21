import crypto from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_REGISTRIES,
  downloadTarball,
  firstRegistry,
  headlessPackageName,
  integrityOf,
  LEGACY_LAYOUT_SCOPES,
  metadataUrl,
  npmScope,
  parseNpmrc,
  readVersion,
  registries,
  tarballUrl,
  uiPackageName,
} from './kitNpm.mjs'

const A = 'https://a.example.test/'
const B = 'https://b.example.test/npm/'

describe('names and addresses', () => {
  it("names a kit's editor and headless packages in the @kition scope", () => {
    expect(uiPackageName('note')).toBe('@kition/kit-note-ui')
    expect(headlessPackageName('note', 'linux-x64')).toBe('@kition/kit-note-linux-x64')
    expect(() => uiPackageName('Note')).toThrow(/not a kit name/)
    expect(() => uiPackageName('../x')).toThrow(/not a kit name/)
  })

  it("addresses a version's metadata and its tarball by npm's convention", () => {
    expect(metadataUrl(A, '@kition/kit-note-ui', '0.1.3')).toBe('https://a.example.test/@kition%2fkit-note-ui/0.1.3')
    expect(metadataUrl('https://b.example.test/npm', '@kition/kit-note-ui', 'latest')).toBe('https://b.example.test/npm/@kition%2fkit-note-ui/latest')
    expect(tarballUrl(A, '@kition/kit-note-ui', '0.1.3')).toBe('https://a.example.test/@kition/kit-note-ui/-/kit-note-ui-0.1.3.tgz')
    expect(tarballUrl(B, '@kition/kit-note-ui', '0.1.3-rc.1')).toBe('https://b.example.test/npm/@kition/kit-note-ui/-/kit-note-ui-0.1.3-rc.1.tgz')
  })

  it("is npm's integrity: sha512 of the bytes in base64", () => {
    const bytes = Buffer.from('a tarball')
    expect(integrityOf(bytes)).toBe(`sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`)
    expect(integrityOf(bytes)).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/)
  })
})

describe('the npm scope (KITION_NPM_SCOPE) and its layout', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('is @kition with the legacy names when the variable is unset or empty', () => {
    expect(LEGACY_LAYOUT_SCOPES).toEqual(['@kition'])
    expect(npmScope({})).toBe('@kition')
    expect(npmScope({ KITION_NPM_SCOPE: '' })).toBe('@kition')
    vi.stubEnv('KITION_NPM_SCOPE', '')
    expect(uiPackageName('note')).toBe('@kition/kit-note-ui')
    expect(headlessPackageName('note', 'linux-x64')).toBe('@kition/kit-note-linux-x64')
    // The legacy names never collide with the scope's other packages.
    expect(uiPackageName('cli', '@kition')).toBe('@kition/kit-cli-ui')
  })

  it("names another scope's packages by layout 1, <scope>/<kit> and <scope>/<kit>-<platform>, from the variable or as asked", () => {
    expect(uiPackageName('note', '@kitionstage')).toBe('@kitionstage/note')
    expect(headlessPackageName('note', 'darwin-arm64', '@kitionstage')).toBe('@kitionstage/note-darwin-arm64')
    vi.stubEnv('KITION_NPM_SCOPE', '@kitionstage')
    expect(npmScope()).toBe('@kitionstage')
    expect(uiPackageName('note')).toBe('@kitionstage/note')
    expect(headlessPackageName('note', 'linux-x64')).toBe('@kitionstage/note-linux-x64')
    expect(tarballUrl(A, '@kitionstage/note', '0.1.3')).toBe('https://a.example.test/@kitionstage/note/-/note-0.1.3.tgz')
    expect(metadataUrl(A, '@kitionstage/note', 'latest')).toBe('https://a.example.test/@kitionstage%2fnote/latest')
    for (const other of ['cli', 'sdk', 'kits', 'tessera']) {
      expect(() => uiPackageName(other)).toThrow(`${other} is not a kit name in @kitionstage`)
      expect(() => headlessPackageName(other, 'linux-x64')).toThrow(/is not a kit name in @kitionstage/)
    }
  })

  it('refuses a scope that is not @ and lowercase letters, digits and dashes', () => {
    for (const bad of ['kition', '@Kition', '@-x', '@', '@kition/x', '@kit ion']) {
      expect(() => npmScope({ KITION_NPM_SCOPE: bad })).toThrow(/KITION_NPM_SCOPE is .*, not an npm scope/)
      expect(() => uiPackageName('note', bad)).toThrow(/not an npm scope/)
      expect(() => registries({ KITION_NPM_SCOPE: bad }, '')).toThrow(/KITION_NPM_SCOPE is/)
    }
  })

  it("reads .npmrc's registry of the scope", () => {
    const npmrc = '@kition:registry=https://kition.example.test\n@kitionstage:registry=https://stage.example.test\n'
    expect(registries({}, npmrc)[0]).toBe('https://kition.example.test/')
    expect(registries({ KITION_NPM_SCOPE: '@kitionstage' }, npmrc)[0]).toBe('https://stage.example.test/')
  })
})

describe('registries', () => {
  it('falls back to npmjs.org, then npmmirror.com', () => {
    expect(DEFAULT_REGISTRIES).toEqual(['https://registry.npmjs.org/', 'https://registry.npmmirror.com/'])
    expect(registries({}, '')).toEqual(DEFAULT_REGISTRIES)
  })

  it('reads KITION_NPM_REGISTRY first, then the @kition scope of .npmrc, then npm_config_registry over .npmrc registry', () => {
    const npmrc = ['# a comment', '@kition:registry=https://scope.example.test', 'registry = "https://npmrc.example.test/"', '//registry.npmjs.org/:_authToken=${NPM_TOKEN}'].join('\n')
    expect(registries({ KITION_NPM_REGISTRY: `${A}, ${B}` }, npmrc)).toEqual([A, B, 'https://scope.example.test/', 'https://npmrc.example.test/', ...DEFAULT_REGISTRIES])
    expect(registries({ npm_config_registry: 'https://env.example.test' }, npmrc)).toEqual(['https://scope.example.test/', 'https://env.example.test/', ...DEFAULT_REGISTRIES])
  })

  it('lists each address once, ends each with a slash, and skips what is not an address', () => {
    expect(registries({ KITION_NPM_REGISTRY: 'https://registry.npmmirror.com,file:///tmp,,registry.npmjs.org' }, '')).toEqual(['https://registry.npmmirror.com/', 'https://registry.npmjs.org/'])
  })

  it('expands ${VAR} in .npmrc and ignores lines without a key', () => {
    expect(parseNpmrc('registry=${MIRROR}/npm\n=x\n; note', { MIRROR: 'https://m.example.test' })).toEqual({ registry: 'https://m.example.test/npm' })
  })
})

/** A fake fetch over `routes` (address to a Response maker or an Error); records every address asked. */
function fakeFetch(routes: Record<string, (() => Response) | Error>) {
  const asked: string[] = []
  const fetchImpl = async (url: string) => {
    asked.push(url)
    const route = routes[url]
    if (route instanceof Error) throw route
    return route ? route() : new Response('not found', { status: 404 })
  }
  return { asked, fetchImpl }
}

const json = (value: unknown, status = 200) => () => new Response(JSON.stringify(value), { status })

describe('reading from the registries in order', () => {
  const meta = { name: '@kition/kit-note-ui', version: '0.1.3', dist: { integrity: integrityOf(Buffer.from('x')) } }

  it('answers from the first registry that has the version', async () => {
    const { asked, fetchImpl } = fakeFetch({ [`${A}@kition%2fkit-note-ui/0.1.3`]: json(meta), [`${B}@kition%2fkit-note-ui/0.1.3`]: json(meta) })
    expect(await readVersion([A, B], '@kition/kit-note-ui', '0.1.3', fetchImpl)).toEqual({ registry: A, value: meta })
    expect(asked).toEqual([`${A}@kition%2fkit-note-ui/0.1.3`])
  })

  it('goes on to the next registry when one does not answer, answers an error, or lacks the version', async () => {
    for (const first of [new Error('ECONNRESET'), json({}, 503), json({}, 404)]) {
      const { fetchImpl } = fakeFetch({ [`${A}@kition%2fkit-note-ui/0.1.3`]: first, [`${B}@kition%2fkit-note-ui/0.1.3`]: json(meta) })
      expect((await readVersion([A, B], '@kition/kit-note-ui', '0.1.3', fetchImpl)).registry).toBe(B)
    }
  })

  it('refuses an answer for another package or version, and names every failure when no registry has it', async () => {
    const { fetchImpl } = fakeFetch({ [`${A}@kition%2fkit-note-ui/0.1.3`]: json({ ...meta, name: '@kition/kit-cad-ui' }), [`${B}@kition%2fkit-note-ui/0.1.3`]: json({ ...meta, version: '0.1.2' }) })
    const error = await readVersion([A, B], '@kition/kit-note-ui', '0.1.3', fetchImpl).catch((caught: Error) => caught)
    expect(String(error)).toMatch(/@kition\/kit-note-ui@0\.1\.3: no registry has it/)
    expect(String(error)).toContain(`${A}: asked for @kition/kit-note-ui@0.1.3, answered @kition/kit-cad-ui@0.1.3`)
    expect(String(error)).toContain(`${B}: asked for @kition/kit-note-ui@0.1.3, answered 0.1.2`)
  })

  it('takes whatever version a dist-tag names', async () => {
    const { fetchImpl } = fakeFetch({ [`${A}@kition%2fkit-note-ui/latest`]: json(meta) })
    expect((await readVersion([A], '@kition/kit-note-ui', 'latest', fetchImpl)).value.version).toBe('0.1.3')
  })

  it('has nothing to try without registries', async () => {
    await expect(firstRegistry([], 'x', async () => 1)).rejects.toThrow(/no registry/)
  })
})

describe('downloadTarball', () => {
  const bytes = Buffer.from('the package bytes')
  const integrity = integrityOf(bytes)
  const at = (registry: string) => tarballUrl(registry, '@kition/kit-note-ui', '0.1.3')

  it('answers the bytes of the first registry that serves them with the integrity', async () => {
    const { asked, fetchImpl } = fakeFetch({ [at(A)]: () => new Response(bytes), [at(B)]: () => new Response(bytes) })
    const got = await downloadTarball([A, B], '@kition/kit-note-ui', '0.1.3', integrity, fetchImpl)
    expect(got.registry).toBe(A)
    expect(Buffer.compare(got.value, bytes)).toBe(0)
    expect(asked).toEqual([at(A)])
  })

  it('skips a registry whose bytes have another integrity, or that fails', async () => {
    const { fetchImpl } = fakeFetch({ [at(A)]: () => new Response(Buffer.from('other bytes')), [at(B)]: () => new Response(bytes) })
    expect((await downloadTarball([A, B], '@kition/kit-note-ui', '0.1.3', integrity, fetchImpl)).registry).toBe(B)
    const down = fakeFetch({ [at(A)]: new Error('ETIMEDOUT'), [at(B)]: () => new Response(bytes) })
    expect((await downloadTarball([A, B], '@kition/kit-note-ui', '0.1.3', integrity, down.fetchImpl)).registry).toBe(B)
  })

  it('fails when no registry serves the pinned bytes, and refuses an integrity that is not npm sha512', async () => {
    const { fetchImpl } = fakeFetch({ [at(A)]: () => new Response(Buffer.from('other bytes')) })
    await expect(downloadTarball([A, B], '@kition/kit-note-ui', '0.1.3', integrity, fetchImpl)).rejects.toThrow(/integrity is sha512-.*, not sha512-[\s\S]*HTTP 404/)
    await expect(downloadTarball([A], '@kition/kit-note-ui', '0.1.3', `sha256-${'a'.repeat(44)}`, fetchImpl)).rejects.toThrow(/not an npm integrity/)
  })
})
