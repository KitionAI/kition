import { describe, expect, it } from 'vitest'
import { installKitCatalog, kitById, kitByName, kitCatalog, kitEditingExtension, kitExtensions, kitViewingExtension, type KitManifest } from './kitCatalog'
import { inferWorkspaceItemFormat, kitForWorkspaceFormat, kitOwningWorkspacePath, knownWorkspaceExtensions, workspaceFormatLabel } from '@/services/workspaceFormats'

// Two kits no build ships, so nothing here leans on a real kit's manifest.
const INK: KitManifest = {
  id: 'kit.ink',
  name: 'Ink',
  engine: { module: 'ink_engine', class: 'InkFile' },
  formats: [
    { id: 'ink', extensions: ['kink', '.INKX'], mime: 'application/vnd.example.ink+zip', role: 'edit' },
    { id: 'old', extensions: ['oink', 'memo'], role: 'view' },
  ],
  creates: [{ id: 'ink', extension: 'kink', baseName: 'Untitled ink', size: { width: 800, height: 600 } }],
  agent: { prefix: 'ink', describe: { noun: 'ink drawing' } },
}
const MEMO: KitManifest = {
  id: 'kit.memo',
  name: 'Memo',
  engine: { module: 'memo_engine', class: 'MemoFile' },
  formats: [{ id: 'memo', extensions: ['memo', 'md'], mime: 'text/markdown' }],
}

const shipped = [...kitCatalog()]

describe('the kit catalog', () => {
  it('opens the files of the kits this build ships as their manifests say', () => {
    // First, before a test installs other kits: the manifests the test setup installs are every
    // shipped kit's (src/test/setup.ts).
    expect(shipped.length).toBeGreaterThan(0)
    for (const entry of shipped) {
      for (const create of entry.creates) expect(kitEditingExtension(create.extension)?.id, `${entry.id} creates .${create.extension}`).toBe(entry.id)
    }
    expect(kitForWorkspaceFormat('csv')).toBeUndefined()
    expect(kitForWorkspaceFormat('csv', { views: true })?.views).toContain('csv')
  })

  it('reads a kit from its manifest: its package, its engine, what it edits, views and creates', () => {
    installKitCatalog([INK, MEMO])
    expect(kitById('kit.ink')).toEqual({
      id: 'kit.ink',
      name: 'ink',
      title: 'Ink',
      embedded: { kitId: 'kit.ink', dir: 'ink-ui' },
      engine: { kitId: 'kit.ink', dir: 'ink-ui/engine', module: 'ink_engine', documentClass: 'InkFile' },
      edits: ['kink', 'inkx'],
      views: ['oink', 'memo'],
      creates: INK.creates,
      text: false,
      agentPrefix: 'ink',
      noun: 'ink drawing',
      outline: false,
    })
    expect(kitByName('memo')).toMatchObject({ id: 'kit.memo', text: true, agentPrefix: null, noun: 'Memo', creates: [], outline: false })
    installKitCatalog([{ ...MEMO, outline: { command: 'memo.outline' } }])
    expect(kitByName('memo')?.outline).toBe(true)
  })

  it('finds the kit that edits an extension, and a kit that views it only when none edits it', () => {
    installKitCatalog([INK, MEMO])
    expect(kitEditingExtension('.KINK')?.id).toBe('kit.ink')
    expect(kitEditingExtension('memo')?.id).toBe('kit.memo')
    expect(kitViewingExtension('memo')).toBeUndefined()
    expect(kitViewingExtension('oink')?.id).toBe('kit.ink')
    expect(kitEditingExtension('oink')).toBeUndefined()
    expect(kitExtensions().sort()).toEqual(['inkx', 'kink', 'md', 'memo', 'oink'])
  })

  it('leaves out what is not a kit manifest', () => {
    installKitCatalog([{ ...INK, id: 'ink' }, { ...MEMO, engine: { module: '', class: 'MemoFile' } }, MEMO])
    expect(kitCatalog().map((entry) => entry.id)).toEqual(['kit.memo'])
  })

  it('names a file by Kition\'s own format, or by the kit that edits or views it', () => {
    installKitCatalog([INK, MEMO])
    expect(inferWorkspaceItemFormat('Notes/Plan.md')).toBe('markdown')
    expect(inferWorkspaceItemFormat('art/Sketch.KINK')).toBe('ink')
    expect(inferWorkspaceItemFormat('art/Old.oink')).toBe('ink')
    expect(inferWorkspaceItemFormat('Photo.png')).toBe('image')
    expect(inferWorkspaceItemFormat('archive.zip')).toBe('binary')
    expect(inferWorkspaceItemFormat('.kink')).toBe('binary')
    expect(workspaceFormatLabel('ink')).toBe('Ink')
    expect(workspaceFormatLabel('markdown')).toBe('MD')
    expect(workspaceFormatLabel('binary')).toBe('File')
    expect(knownWorkspaceExtensions()).toEqual(expect.arrayContaining(['md', 'png', 'kink', 'oink']))
  })

  it('finds the kit of a format: the kit of that name, or the kit that edits the format\'s usual extension', () => {
    installKitCatalog([INK, MEMO])
    expect(kitForWorkspaceFormat('ink')?.id).toBe('kit.ink')
    expect(kitForWorkspaceFormat('markdown')?.id).toBe('kit.memo')
    expect(kitForWorkspaceFormat('image')).toBeUndefined()
    expect(kitForWorkspaceFormat(undefined)).toBeUndefined()
    expect(kitOwningWorkspacePath('a.kink')?.id).toBe('kit.ink')
    // Markdown is a format of Kition's own, whichever kit edits it.
    expect(kitOwningWorkspacePath('a.md')).toBeUndefined()
  })

  it('knows nothing about a kit that is not in the build', () => {
    installKitCatalog([MEMO])
    expect(inferWorkspaceItemFormat('art/Sketch.kink')).toBe('binary')
    expect(kitForWorkspaceFormat('ink')).toBeUndefined()
    expect(kitOwningWorkspacePath('art/Sketch.kink')).toBeUndefined()
  })
})
