import { describe, expect, it } from 'vitest'
import { cleanWorkspacePath, readExtensionFromWorkspace } from './extensionPackage'
import { makeZip } from './testZip'
import { readZip } from './zip'

const manifest = {
  kitExtensions: '1.0',
  id: 'com.example.titles',
  name: 'Titles',
  version: '1.0.0',
  entry: 'extension.mjs',
  activation: { kits: ['kit.slide'] },
  contributes: { commands: [{ id: 'titles.apply', title: 'Apply' }] },
  permissions: ['model.read'],
}
const SOURCE = 'export function activate() {}'

function workspace(files: Record<string, string | Uint8Array>) {
  const reads: string[] = []
  const read = async (path: string) => {
    reads.push(path)
    const file = files[path]
    if (file === undefined) throw new Error(`could not read ${path} (404)`)
    const bytes = typeof file === 'string' ? new TextEncoder().encode(file) : file
    return bytes.slice().buffer as ArrayBuffer
  }
  return { read, reads }
}

describe('readZip', () => {
  it('reads stored and deflated entries', async () => {
    for (const deflate of [false, true]) {
      const entries = readZip(await makeZip({ 'a.txt': 'one', 'folder/b.txt': 'two '.repeat(100) }, deflate))
      expect([...entries.keys()]).toEqual(['a.txt', 'folder/b.txt'])
      expect(new TextDecoder().decode(await entries.get('folder/b.txt')!.read())).toBe('two '.repeat(100))
    }
  })

  it('refuses what is not a zip archive', () => {
    expect(() => readZip(new TextEncoder().encode('not a zip at all, just some text that is long enough'))).toThrow(/not a zip archive/)
  })
})

describe('readExtensionFromWorkspace', () => {
  it('reads a folder, or its extension.json', async () => {
    const { read } = workspace({ 'extensions/titles/extension.json': JSON.stringify(manifest), 'extensions/titles/extension.mjs': SOURCE })
    for (const path of ['extensions/titles', 'extensions/titles/', '/extensions/titles/extension.json']) {
      const extension = await readExtensionFromWorkspace(path, read)
      expect(extension).toMatchObject({ manifest: { id: 'com.example.titles' }, source: SOURCE, from: path.replace(/^\/|\/$/g, '') })
    }
  })

  it('reads a zip with extension.json at its root or in its top folder', async () => {
    const { read } = workspace({
      'flat.zip': await makeZip({ 'extension.json': JSON.stringify(manifest), 'extension.mjs': SOURCE }, true),
      'nested.zip': await makeZip({ 'titles/extension.json': JSON.stringify(manifest), 'titles/extension.mjs': SOURCE }),
      'empty.zip': await makeZip({ 'readme.txt': 'nothing here' }),
    })
    await expect(readExtensionFromWorkspace('flat.zip', read)).resolves.toMatchObject({ source: SOURCE })
    await expect(readExtensionFromWorkspace('nested.zip', read)).resolves.toMatchObject({ source: SOURCE })
    await expect(readExtensionFromWorkspace('empty.zip', read)).rejects.toThrow(/has no extension\.json/)
  })

  it("reads each panel's HTML, from a folder or a zip", async () => {
    const withPanel = { ...manifest, contributes: { ...manifest.contributes, panels: [{ id: 'titles.panel', title: 'Titles', entry: 'panels/titles.html' }] } }
    const { read } = workspace({
      'titles/extension.json': JSON.stringify(withPanel),
      'titles/extension.mjs': SOURCE,
      'titles/panels/titles.html': '<p>Titles</p>',
      'titles.zip': await makeZip({ 'titles/extension.json': JSON.stringify(withPanel), 'titles/extension.mjs': SOURCE, 'titles/panels/titles.html': '<p>Zipped</p>' }),
      'broken.zip': await makeZip({ 'extension.json': JSON.stringify(withPanel), 'extension.mjs': SOURCE }),
      'broken/extension.json': JSON.stringify(withPanel),
      'broken/extension.mjs': SOURCE,
    })
    await expect(readExtensionFromWorkspace('titles', read)).resolves.toMatchObject({ files: { 'panels/titles.html': '<p>Titles</p>' } })
    await expect(readExtensionFromWorkspace('titles.zip', read)).resolves.toMatchObject({ files: { 'panels/titles.html': '<p>Zipped</p>' } })
    await expect(readExtensionFromWorkspace('broken.zip', read)).rejects.toThrow(/has no panels\/titles\.html/)
    await expect(readExtensionFromWorkspace('broken', read)).rejects.toThrow(/could not read broken\/panels\/titles\.html/)
    await expect(readExtensionFromWorkspace('extensions/none', workspace({ 'extensions/none/extension.json': JSON.stringify(manifest), 'extensions/none/extension.mjs': SOURCE }).read)).resolves.toMatchObject({ files: {} })
  })

  it('refuses an invalid manifest before reading its code', async () => {
    const { read, reads } = workspace({ 'bad/extension.json': JSON.stringify({ ...manifest, permissions: ['files.read'] }), 'bad/extension.mjs': SOURCE })
    await expect(readExtensionFromWorkspace('bad', read)).rejects.toThrow(/unknown permission files\.read/)
    expect(reads).toEqual(['bad/extension.json'])
  })

  it('stays inside the workspace', () => {
    expect(() => cleanWorkspacePath('../outside')).toThrow(/not a path in the workspace/)
    expect(() => cleanWorkspacePath('  ')).toThrow()
    expect(cleanWorkspacePath(' a\\b/./c ')).toBe('a/b/c')
  })
})
