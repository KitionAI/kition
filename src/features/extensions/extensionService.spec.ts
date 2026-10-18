import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { deleteDB } from 'idb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MountedKitDocument } from '@/features/kits/public'
import { RpcPeer, SANDBOX_TAG, type ExtensionNotice, type SandboxFactory } from '@/lib/extensions'
import { WORKER_RUNTIME } from '@/lib/extensions/generated/runtime'
import { parseSchema, person, Replica, Version } from '@/lib/kdm'
import { registerKit } from '@/lib/sdk'

const files = new Map<string, string>()
const mounted: { listener: ((document: MountedKitDocument) => (() => void) | void) | null; active: MountedKitDocument | null } = { listener: null, active: null }
const notices: Array<{ level: string; title: string; description?: string }> = []

vi.mock('@/features/kits/public', () => ({
  KITION_KIT_HOST: {
    read: async (path: string) => {
      const text = files.get(path)
      if (text === undefined) throw new Error(`could not read ${path} (404)`)
      return { bytes: new TextEncoder().encode(text).buffer, stamp: '1' }
    },
  },
  followKitConnections: (listener: (document: MountedKitDocument) => (() => void) | void) => {
    mounted.listener = listener
    if (mounted.active) listener(mounted.active)
    return () => {
      mounted.listener = null
    }
  },
  activeKitDocument: () => mounted.active,
}))
vi.mock('@/lib/notify', () => {
  const record = (level: string) => (title: string, options?: { description?: string }) => notices.push({ level, title, ...(options?.description ? { description: options.description } : {}) })
  return { notify: { success: record('success'), error: record('error'), info: record('info'), warning: record('warning') } }
})

const { ExtensionService } = await import('./extensionService')
const { closeExtensionStore, listInstalledExtensions } = await import('./extensionStore')

const schema = parseSchema(readFileSync(resolve(process.cwd(), 'crates/kition-kdm/tests/fixtures/test-schema.json'), 'utf8'))
registerKit({ id: 'kit.test', schema })

/**
 * The built sandbox worker (WORKER_RUNTIME), run in this process: blob URLs become data URLs, and
 * its one `import()` goes through this module (code made with `new Function` has no importer here).
 */
const runtimeSource = WORKER_RUNTIME.split('import(')
if (runtimeSource.length !== 2) throw new Error('the worker runtime should import the extension in exactly one place')
const importModule = (url: string) => import(/* @vite-ignore */ url)
const runtimeSandbox: SandboxFactory = async () => {
  const channel = new MessageChannel()
  const scope: { onmessage: ((event: unknown) => void) | null } = { onmessage: null }
  class FakeBlob {
    constructor(readonly parts: string[]) {}
  }
  const FakeURL = { createObjectURL: (blob: FakeBlob) => `data:text/javascript;base64,${Buffer.from(blob.parts.join('')).toString('base64')}`, revokeObjectURL: () => undefined }
  new Function('self', 'URL', 'Blob', 'importModule', runtimeSource.join('importModule('))(scope, FakeURL, FakeBlob, importModule)
  scope.onmessage!({ data: { tag: SANDBOX_TAG, type: 'port' }, ports: [channel.port2] })
  return {
    port: channel.port1,
    dispose: () => {
      channel.port1.close()
      channel.port2.close()
    },
  }
}

/** A kit editor's connection over a replica of the test schema (a page with a title). */
function fakeKitDocument(path: string, readOnly = false): MountedKitDocument & { title: () => unknown } {
  const replica = Replica.create(schema, '01920000-0000-7000-8000-0000000000cc', 7n)
  replica.transact(person('user:a'), (tx) => {
    tx.create('Page', { title: 'quarterly review' }, { id: 'page' })
  })
  const toBuffer = (bytes: Uint8Array) => bytes.slice().buffer as ArrayBuffer
  const connection = {
    kit: { id: 'kit.test' },
    capabilities: ['replica'],
    ai: {
      commands: async () => [],
      run: async () => ({ completed: [] }),
    },
    replica: {
      exportChanges: async (since: ArrayBuffer) => ({ changes: toBuffer(replica.exportChanges(since.byteLength ? Version.decode(new Uint8Array(since)) : Version.empty())), blobs: new ArrayBuffer(0) }),
      importChanges: async (changes: ArrayBuffer) => {
        replica.importChanges(new Uint8Array(changes))
        return { damage: null }
      },
      onChanged: () => () => undefined,
    },
  }
  return { path, kitId: 'kit.test', connection: connection as never, readOnly, title: () => replica.get('page', 'title') }
}

const manifest = (permissions: string[]) => ({
  kitExtensions: '1.0',
  id: 'com.example.titles',
  name: 'Titles',
  version: '1.0.0',
  entry: 'extension.mjs',
  activation: { kits: ['kit.test'] },
  contributes: { commands: [{ id: 'titles.upper', title: 'Upper-case the title' }] },
  permissions,
})
const SOURCE = `
export function activate(ctx) {
  ctx.commands.register('titles.upper', () => ctx.document.run(async (context) => {
    context.root.load(['title'])
    await context.sync()
    context.root.title = context.root.title.toUpperCase()
    ctx.notify('Upper-cased', { level: 'success' })
  }))
}
`

let service: InstanceType<typeof ExtensionService> | null = null

beforeEach(async () => {
  await closeExtensionStore()
  await deleteDB('kition-extensions')
  files.clear()
  notices.length = 0
  mounted.active = null
})
afterEach(() => {
  service?.dispose()
  service = null
})

function start() {
  const extensionNotices: ExtensionNotice[] = []
  service = new ExtensionService({ sandbox: runtimeSandbox, notify: (notice) => extensionNotices.push(notice) })
  return { service, extensionNotices }
}

describe('ExtensionService', () => {
  it('installs an extension from the workspace and runs its command on the kit document shown now', async () => {
    files.set('ext/titles/extension.json', JSON.stringify(manifest(['model.read', 'model.write'])))
    files.set('ext/titles/extension.mjs', SOURCE)
    const document = fakeKitDocument('Deck.test')
    mounted.active = document
    const { service, extensionNotices } = start()
    await service.ready

    const installed = await service.install('ext/titles')
    expect(installed).toMatchObject({ id: 'com.example.titles', enabled: true, from: 'ext/titles' })
    expect(service.getSnapshot().installed.map((extension) => extension.id)).toEqual(['com.example.titles'])
    expect((await listInstalledExtensions()).map((extension) => extension.id)).toEqual(['com.example.titles'])

    const [command] = service.paletteCommands()
    expect(command).toMatchObject({ id: 'titles.upper', title: 'Upper-case the title', documentPath: 'Deck.test', extension: 'com.example.titles' })
    await service.runCommand(command)
    expect(document.title()).toBe('QUARTERLY REVIEW')
    expect(extensionNotices).toEqual([{ extension: 'com.example.titles', level: 'success', title: 'Upper-cased' }])
    expect(notices).toEqual([])
  })

  it('shows a refusal when an extension without model.write tries to change the document', async () => {
    files.set('ext/titles/extension.json', JSON.stringify(manifest(['model.read'])))
    files.set('ext/titles/extension.mjs', SOURCE)
    const document = fakeKitDocument('Deck.test')
    mounted.active = document
    const { service } = start()
    await service.install('ext/titles/extension.json')
    await service.runCommand(service.paletteCommands()[0])
    expect(document.title()).toBe('quarterly review')
    expect(notices).toEqual([{ level: 'error', title: 'Upper-case the title failed', description: expect.stringMatching(/model\.write/) }])
  })

  it('disables, enables, and removes extensions, and loads the enabled ones when it starts', async () => {
    files.set('ext/titles/extension.json', JSON.stringify(manifest(['model.read', 'model.write'])))
    files.set('ext/titles/extension.mjs', SOURCE)
    mounted.active = fakeKitDocument('Deck.test')
    const first = start().service
    await first.install('ext/titles')
    await first.setEnabled('com.example.titles', false)
    expect(first.paletteCommands()).toEqual([])
    first.dispose()

    const second = start().service
    await second.ready
    expect(second.getSnapshot().installed).toMatchObject([{ id: 'com.example.titles', enabled: false }])
    expect(second.paletteCommands()).toEqual([])
    await second.setEnabled('com.example.titles', true)
    expect(second.paletteCommands()).toHaveLength(1)
    await second.remove('com.example.titles')
    expect(second.paletteCommands()).toEqual([])
    expect(await listInstalledExtensions()).toEqual([])
  })

  it("lists an extension's panels for the kit document shown now, keeps their HTML, and connects one to the extension", async () => {
    const withPanel = { ...manifest(['model.read']), contributes: { commands: [], panels: [{ id: 'titles.panel', title: 'Title', entry: 'panel.html' }] } }
    files.set('ext/titles/extension.json', JSON.stringify(withPanel))
    files.set('ext/titles/panel.html', '<p id="title"></p>')
    files.set(
      'ext/titles/extension.mjs',
      `export function activate(ctx) {
        ctx.panels.register('titles.panel', (panel) => panel.onRequest(() => ctx.document.run(async (context) => {
          context.root.load(['title'])
          await context.sync()
          return context.root.title
        })))
      }`,
    )
    mounted.active = fakeKitDocument('Deck.test')
    const first = start().service
    await first.install('ext/titles')
    expect(first.palettePanels()).toEqual([expect.objectContaining({ id: 'titles.panel', title: 'Title', extension: 'com.example.titles', extensionName: 'Titles', documentPath: 'Deck.test' })])
    expect(first.enabled('com.example.titles')).toBe(true)
    first.dispose()

    // Started again, from the app's storage: the panel's HTML came with it.
    const { service } = start()
    await service.ready
    expect(service.host.panelContent('com.example.titles', 'titles.panel')).toMatchObject({ html: '<p id="title"></p>', connect: "'none'" })
    const channel = new MessageChannel()
    const panel = new RpcPeer(channel.port1)
    try {
      await service.host.openPanel('Deck.test', 'com.example.titles', 'titles.panel', channel.port2)
      await expect(panel.request('panel/request', null)).resolves.toBe('quarterly review')
    } finally {
      panel.close()
    }
    await service.setEnabled('com.example.titles', false)
    expect(service.enabled('com.example.titles')).toBe(false)
    expect(service.palettePanels()).toEqual([])
  })

  it("tells when a document's editor opens again, and a panel opened on the new editor works", async () => {
    const withPanel = { ...manifest(['model.read']), contributes: { commands: [], panels: [{ id: 'titles.panel', title: 'Title', entry: 'panel.html' }] } }
    files.set('ext/titles/extension.json', JSON.stringify(withPanel))
    files.set('ext/titles/panel.html', '<p id="title"></p>')
    files.set(
      'ext/titles/extension.mjs',
      `export function activate(ctx) {
        ctx.panels.register('titles.panel', (panel) => panel.onRequest(() => ctx.document.run(async (context) => {
          context.root.load(['title'])
          await context.sync()
          return context.root.title
        })))
      }`,
    )
    const { service } = start()
    await service.install('ext/titles')
    const heard: Array<number | null> = []
    const unsubscribe = service.subscribeDocuments(() => heard.push(service.documentOpening('Deck.test')))
    expect(service.documentOpening('Deck.test')).toBeNull()

    const first = mounted.listener!(fakeKitDocument('Deck.test')) as () => void
    const opening = service.documentOpening('Deck.test')
    expect(opening).not.toBeNull()
    const firstChannel = new MessageChannel()
    const firstPanel = new RpcPeer(firstChannel.port1)
    await service.host.openPanel('Deck.test', 'com.example.titles', 'titles.panel', firstChannel.port2)
    await expect(firstPanel.request('panel/request', null)).resolves.toBe('quarterly review')

    // A role change: the editor closes and opens again, read-only. The old session has ended.
    first()
    expect(service.documentOpening('Deck.test')).toBeNull()
    await expect(firstPanel.request('panel/request', null, 1_000)).rejects.toThrow()
    const second = mounted.listener!(fakeKitDocument('Deck.test', true)) as () => void
    const reopened = service.documentOpening('Deck.test')
    expect(reopened).not.toBeNull()
    expect(reopened).not.toBe(opening)
    expect(heard).toEqual([opening, null, reopened])

    const channel = new MessageChannel()
    const panel = new RpcPeer(channel.port1)
    try {
      await service.host.openPanel('Deck.test', 'com.example.titles', 'titles.panel', channel.port2)
      await expect(panel.request('panel/request', null)).resolves.toBe('quarterly review')
    } finally {
      panel.close()
      firstPanel.close()
      unsubscribe()
      second()
    }
  })

  it('runs a workspace script against the kit document shown now', async () => {
    files.set('scripts/upper.mjs', `export default async function (ctx) {
      await ctx.document.run(async (context) => { context.root.title = 'From a script' })
      return { kit: ctx.document.kitId }
    }`)
    files.set('notes.txt', 'not a script')
    const document = fakeKitDocument('Deck.test')
    mounted.active = document
    const { service } = start()
    await service.ready
    await expect(service.runScript('scripts/upper.mjs')).resolves.toBe(true)
    expect(document.title()).toBe('From a script')
    expect(notices).toEqual([{ level: 'success', title: 'Ran upper.mjs', description: '{"kit":"kit.test"}' }])

    await expect(service.runScript('notes.txt')).resolves.toBe(false)
    expect(notices.at(-1)).toEqual({ level: 'error', title: 'notes.txt failed', description: 'Choose a .mjs file' })
  })

  it('refuses a script while no kit document is shown', async () => {
    files.set('scripts/upper.mjs', 'export default () => 1')
    const { service } = start()
    await service.ready
    await expect(service.runScript('scripts/upper.mjs')).resolves.toBe(false)
    expect(notices).toEqual([{ level: 'error', title: 'upper.mjs failed', description: 'Open a kit document first' }])
  })
})
