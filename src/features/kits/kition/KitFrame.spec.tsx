import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { newDocId, parseSchema, person, randomActor, Replica, system, Version } from '@/lib/kdm'

type Opened = {
  /** The frame the kit was mounted in: a kit page answers one handshake, so each open needs its own. */
  element: unknown
  readOnly: boolean
  replica: Replica
  /** The slide file's slide titles, as the kit's replica holds them. */
  titles: () => string[]
  /** An edit: a slide titled `title` added at the end. */
  edit: (title: string) => void
  /** Saves the replica with the file (the file itself stays as it is, as in a host that keeps no saved file). */
  saveReplica: () => Promise<void>
  imports: number
  closed: boolean
  write: (params: { path: string; bytes: ArrayBuffer; mode: 'save' | 'export' | 'create' }) => Promise<{ path: string; version: string }>
  read: (params: { path: string; offset?: number; length?: number }) => Promise<{ bytes: ArrayBuffer; version: string; size: number }>
  stamp: (params: { path: string }) => Promise<{ version: string | null }>
  shortcuts: string[]
  shortcut: (key: { key: string; code: string; meta: boolean; ctrl: boolean; shift: boolean; alt: boolean }) => void
}

const encode = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer
const decode = (bytes: ArrayBuffer) => new TextDecoder().decode(bytes)
const buffer = (bytes: Uint8Array) => bytes.slice().buffer as ArrayBuffer

/** A slide file, as a kit keeps it in a real KDM replica: slides with titles. */
const slideSchema = parseSchema({
  kdm: 1,
  kit: 'kit.test',
  schemaVersion: 1,
  root: 'Presentation',
  types: { Presentation: { fields: { slides: { kind: 'list', of: 'Slide' } } }, Slide: { fields: { title: { kind: 'string' } } } },
})

const slideTitles = (replica: Replica) => {
  const [slideFile] = replica.objectsOfType('Presentation')
  return replica.list(slideFile, 'slides').map((slide) => String(replica.get(slide, 'title')))
}

/** The file: the slide file's titles as JSON (empty bytes: no file, the replica alone is the document). */
const fileState = { titles: ['Title', 'Agenda'], stamp: 'v1' }
/** The replica saved with the file, as the host's document store keeps it. */
const store: { replica: { snapshot: ArrayBuffer; blobs: ArrayBuffer; fileStamp: string } | null } = { replica: null }

/** Every kit opened, oldest first. */
const opened: Opened[] = []

type FakeOptions = {
  document: { path: string; bytes: ArrayBuffer; version?: string | null; readOnly?: boolean }
  shortcuts: string[]
  handlers: {
    write: Opened['write']
    read: Opened['read']
    stamp: Opened['stamp']
    shortcut: Opened['shortcut']
    replicaRead: (params: { path: string }) => Promise<{ snapshot: ArrayBuffer; blobs: ArrayBuffer; fileStamp: string } | null>
    replicaWrite: (params: { path: string; snapshot: ArrayBuffer; blobs: ArrayBuffer; fileStamp: string }) => Promise<void>
  }
}

/**
 * A kit as the standard's kits open a document: from the replica saved with the file when it was
 * saved with the file as it is now, else a new replica (a new document) made from the file. When
 * the saved replica does not hold the file's content, the file wins, recorded onto the replica as
 * new slides (as the Slide kit does).
 */
async function openFakeKit(element: unknown, options: FakeOptions): Promise<Opened> {
  const { document, handlers } = options
  const file = document.bytes.byteLength ? (JSON.parse(decode(document.bytes)) as string[]) : null
  const stored = await handlers.replicaRead({ path: document.path })
  const build = (titles: string[]) => (tx: Parameters<Parameters<Replica['transact']>[1]>[0], slideFile: string) => {
    for (const title of titles) tx.listInsert(slideFile, 'slides', tx.list(slideFile, 'slides').length, tx.create('Slide', { title }))
  }
  let replica: Replica
  if (stored && stored.fileStamp === document.version) {
    replica = Replica.load(slideSchema, new Uint8Array(stored.snapshot), randomActor())
    if (file && JSON.stringify(slideTitles(replica)) !== JSON.stringify(file)) {
      replica.transact(system('import'), (tx) => {
        const [slideFile] = replica.objectsOfType('Presentation')
        for (let index = tx.list(slideFile, 'slides').length - 1; index >= 0; index -= 1) tx.listRemove(slideFile, 'slides', index)
        build(file)(tx, slideFile)
      })
    }
  } else {
    replica = Replica.createWith(slideSchema, newDocId(), randomActor(), system('create'), (tx) => build(file ?? [])(tx, tx.create('Presentation', {}))).replica
  }
  return {
    element,
    readOnly: Boolean(document.readOnly),
    replica,
    titles: () => slideTitles(replica),
    edit: (title) => replica.transact(person('user:test'), (tx) => build([title])(tx, replica.objectsOfType('Presentation')[0])),
    saveReplica: () => handlers.replicaWrite({ path: document.path, snapshot: buffer(replica.snapshot()), blobs: new ArrayBuffer(0), fileStamp: fileState.stamp }),
    imports: 0,
    closed: false,
    write: handlers.write,
    read: handlers.read,
    stamp: handlers.stamp,
    shortcuts: options.shortcuts,
    shortcut: handlers.shortcut,
  }
}

vi.mock('../host/mountKit', () => ({
  mountKit: vi.fn(async (element: unknown, options: FakeOptions) => {
    const kit = await openFakeKit(element, options)
    opened.push(kit)
    return {
      capabilities: ['replica'],
      titles: kit.titles,
      close: () => {
        kit.closed = true
      },
      setLocale: () => undefined,
      focus: () => undefined,
      replica: {
        version: async () => buffer(kit.replica.version().encode()),
        exportChanges: async (since: ArrayBuffer) => ({
          changes: buffer(kit.replica.exportChanges(since.byteLength ? Version.decode(new Uint8Array(since)) : Version.empty())),
          blobs: new ArrayBuffer(0),
        }),
        importChanges: async (changes: ArrayBuffer) => {
          kit.imports += 1
          kit.replica.importChanges(new Uint8Array(changes))
        },
        info: async () => kit.replica.docId,
        onChanged: () => () => undefined,
      },
      ai: {},
    }
  }),
}))

/** The workspace files that exist (`stamp` answers null for any other path). */
const existing = new Set(['Shared/Poster.test', 'Shared/Poster.mp4'])
/** The paths read through each of Kition's two file services: its own, and the one kits read through (rule LR2). */
const reads: { host: string[]; kit: string[] } = { host: [], kit: [] }
vi.mock('./kitionHost', () => ({
  KITION_KIT_HOST: {
    read: async (path: string) => {
      reads.host.push(path)
      return { bytes: encode(JSON.stringify(fileState.titles)), stamp: fileState.stamp }
    },
    stamp: async (path: string) => {
      reads.host.push(path)
      return existing.has(path) ? fileState.stamp : null
    },
    lend: () => null,
  },
  readKitFile: async (path: string) => {
    reads.kit.push(path)
    return { bytes: encode('lent'), stamp: 'lent-1' }
  },
  stampKitFile: async (path: string) => {
    reads.kit.push(path)
    return 'lent-1'
  },
  readKitReplica: async () => store.replica,
  writeKitReplica: async (_path: string, _kitId: string, replica: { snapshot: ArrayBuffer; blobs: ArrayBuffer; fileStamp: string }) => {
    store.replica = replica
  },
  compactKitReplica: async () => undefined,
}))

const writes: Array<{ path: string; document?: string }> = []
vi.mock('@/api/kits', () => ({ writeKitFile: vi.fn(async (path: string, _bytes: Uint8Array, options?: { document?: string }) => void writes.push({ path, ...options })) }))
vi.mock('./kitBridge', () => ({ registerBridgeEditor: () => () => undefined, reportBridgeChange: () => undefined }))
vi.mock('./kitTestBridge', () => ({ registerKitTestFrame: () => () => undefined }))
vi.mock('./pickWorkspaceFile', () => ({ pickWorkspaceFile: async () => null }))

const relayed: string[][] = []
vi.mock('./kitConnections', () => ({
  // What co-editing would relay from: the replica the kit had when it was offered.
  registerKitConnection: vi.fn((document: { connection: { titles: () => string[] } }) => {
    relayed.push(document.connection.titles())
    return () => undefined
  }),
  markKitDocumentShown: vi.fn(),
}))

import { setReadOnlyDocuments } from '@/services/documentAccess'
import { mountKit } from '../host/mountKit'
import { KitFrame } from './KitFrame'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as { __APP_VERSION__?: string }).__APP_VERSION__ = 'test'

const KIT = { kitId: 'kit.test', dir: 'test-ui' }
const PATH = 'Shared/Poster.test'

let container: HTMLDivElement
let root: Root | null = null

async function settle() {
  for (let round = 0; round < 5; round += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
}

/** Saves a replica made from the file with it, as opening a shared document does. */
function keepReplicaOfFile() {
  const replica = Replica.createWith(slideSchema, newDocId(), randomActor(), system('create'), (tx) => {
    const slideFile = tx.create('Presentation', {})
    fileState.titles.forEach((title, index) => tx.listInsert(slideFile, 'slides', index, tx.create('Slide', { title })))
  }).replica
  store.replica = { snapshot: buffer(replica.snapshot()), blobs: new ArrayBuffer(0), fileStamp: fileState.stamp }
}

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(KitFrame, { kit: KIT, path: PATH, active: true }))
  })
  await settle()
}

beforeEach(() => {
  opened.length = 0
  relayed.length = 0
  writes.length = 0
  reads.host.length = 0
  reads.kit.length = 0
  fileState.titles = ['Title', 'Agenda']
  store.replica = null
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container?.remove()
  setReadOnlyDocuments([])
})

describe('KitFrame', () => {
  it('names the file it could not open, says it was not changed, and opens it again on request', async () => {
    vi.mocked(mountKit).mockRejectedValueOnce(new Error('codec: unrecognized image format'))
    await mount()
    const notice = container.querySelector('[data-testid="kit-open-failed"]')
    expect(notice?.getAttribute('role')).toBe('alert')
    expect(notice?.querySelector('h2')?.textContent).toBe('Could not open Poster.test')
    expect(notice?.textContent).toContain('The file may be damaged or not a valid TEST file. It has not been changed.')
    expect(notice?.querySelector('[data-testid="file-notice-detail"]')?.textContent).toBe('codec: unrecognized image format')
    expect(opened).toHaveLength(0)

    await act(async () => (container.querySelector('[data-testid="kit-open-retry"]') as HTMLButtonElement).click())
    await settle()
    expect(container.querySelector('[data-testid="kit-open-failed"]')).toBeNull()
    expect(opened).toHaveLength(1)
  })

  it("has the kit forward Kition's palette key, Cmd+., and keep Cmd+K for itself", async () => {
    await mount()
    expect(opened[0].shortcuts).toContain('Cmd+.')
    expect(opened[0].shortcuts).not.toContain('Cmd+K')
    const keys: Array<{ key: string; metaKey: boolean }> = []
    const listen = (event: KeyboardEvent) => keys.push({ key: event.key, metaKey: event.metaKey })
    window.addEventListener('keydown', listen)
    try {
      // A forwarded key reaches Kition's window as if pressed there (Shell opens the palette on Mod+.).
      opened[0].shortcut({ key: '.', code: 'Period', meta: true, ctrl: false, shift: false, alt: false })
    } finally {
      window.removeEventListener('keydown', listen)
    }
    expect(keys).toEqual([{ key: '.', metaKey: true }])
  })

  it('opens a document this person may only view read-only, and refuses to save it', async () => {
    setReadOnlyDocuments([PATH])
    await mount()
    expect(opened.map((kit) => kit.readOnly)).toEqual([true])
    await expect(opened[0].write({ path: PATH, bytes: new ArrayBuffer(1), mode: 'save' })).rejects.toThrow(/read-only/)
    expect(writes).toEqual([])
  })

  it('saves only the document the frame opened, and names it to the runtime', async () => {
    await mount()
    const kit = opened[0]
    // Another file of the same kind, other kits' files, and a path that climbs out to another file.
    for (const other of ['Shared/Other.test', 'Shared/Cover.psd', 'Report.docx', 'Shared/./Poster.test/../Other.test']) {
      await expect(kit.write({ path: other, bytes: new ArrayBuffer(1), mode: 'save' })).rejects.toThrow(/not this editor's document|outside the workspace/)
    }
    expect(writes).toEqual([])
    await expect(kit.write({ path: PATH, bytes: new ArrayBuffer(1), mode: 'save' })).resolves.toMatchObject({ path: PATH })
    expect(writes).toEqual([{ path: PATH, document: PATH }])
  })

  it('writes exports and new files as new files only, never naming a document', async () => {
    await mount()
    await opened[0].write({ path: 'Shared/Poster.mp4', bytes: new ArrayBuffer(1), mode: 'export' })
    expect(writes).toEqual([{ path: 'Shared/Poster 2.mp4' }])
  })

  it("reads the document and other workspace files, but never Kition's store or hidden paths", async () => {
    await mount()
    const kit = opened[0]
    reads.host.length = 0
    for (const hidden of ['.kition/docs/index.json', '.kition/drafts/a/draft.bin', 'Shared/.hidden/cover.png', '.git/config', 'Shared/.env']) {
      await expect(kit.read({ path: hidden })).rejects.toThrow(/not readable by a kit/)
      await expect(kit.stamp({ path: hidden })).rejects.toThrow(/not readable by a kit/)
    }
    await expect(kit.read({ path: '../outside.png' })).rejects.toThrow(/outside the workspace/)
    expect(reads).toEqual({ host: [], kit: [] })
    // Files beside the document, and elsewhere in the workspace (media a project links), through the lent-file service.
    await expect(kit.read({ path: 'Shared/cover.png', offset: 1, length: 2 })).resolves.toMatchObject({ size: 4, version: 'lent-1' })
    await expect(kit.stamp({ path: 'Clips/intro.mp4' })).resolves.toEqual({ version: 'lent-1' })
    // The document itself, through Kition's own service, wherever it is.
    await expect(kit.read({ path: PATH })).resolves.toMatchObject({ version: 'v1' })
    expect(reads).toEqual({ host: [PATH], kit: ['Shared/cover.png', 'Clips/intro.mp4'] })
  })

  it('keeps every edit, unsaved ones too, when a role change opens the kit again read-only', async () => {
    // A co-edited document opens from the replica saved with its file (the shared one).
    keepReplicaOfFile()
    await mount()
    const [kit] = opened
    expect(kit.readOnly).toBe(false)
    // Edits made while an editor, not saved (and not necessarily in the room yet).
    kit.edit('Budget')
    kit.edit('Plan')

    await act(async () => setReadOnlyDocuments([PATH]))
    await settle()

    expect(opened.map((each) => each.readOnly)).toEqual([false, true])
    expect(opened[0].closed).toBe(true)
    // The kit opened again is a new page in a new frame; the old frame is gone.
    expect(opened[1].element).not.toBe(opened[0].element)
    expect((opened[0].element as HTMLElement).isConnected).toBe(false)
    expect(container.querySelectorAll('iframe')).toHaveLength(1)
    // It opened the saved replica, an earlier state of the same one, and took the edits on it.
    // Importing the carried changes loads the replica engine first, which can take longer than
    // settle()'s rounds on a busy machine: wait for the import itself.
    await vi.waitFor(() => expect(opened[1].imports).toBe(1), { timeout: 10_000 })
    expect(opened[1].titles()).toEqual(['Title', 'Agenda', 'Budget', 'Plan'])
    // The kit opened again had the edits before co-editing was offered it.
    expect(relayed.at(-1)).toEqual(['Title', 'Agenda', 'Budget', 'Plan'])
    expect(writes).toEqual([])
  })

  it('opens the kit editable again when the role becomes editor, with what the viewer had', async () => {
    setReadOnlyDocuments([PATH])
    keepReplicaOfFile()
    await mount()
    opened[0].edit('From the room')
    await act(async () => setReadOnlyDocuments([]))
    await settle()
    expect(opened.map((kit) => kit.readOnly)).toEqual([true, false])
    expect(opened[1].element).not.toBe(opened[0].element)
    expect(opened[1].titles()).toEqual(['Title', 'Agenda', 'From the room'])
  })

  it('opens the kit again from the replica it replaces when no replica was saved with the file, importing nothing into another', async () => {
    await mount()
    opened[0].edit('Budget')
    const docId = opened[0].replica.docId

    await act(async () => setReadOnlyDocuments([PATH]))
    await settle()

    // The first kit opened again made a new replica from the file: closed without the edits
    // imported (they would have been another document's), then a new page opened from the
    // carried replica alone.
    expect(opened.map((kit) => kit.readOnly)).toEqual([false, true, true])
    expect(opened[1].imports).toBe(0)
    expect(opened[1].closed).toBe(true)
    expect(opened[2].closed).toBe(false)
    expect(opened[2].element).not.toBe(opened[1].element)
    expect(container.querySelectorAll('iframe')).toHaveLength(1)
    expect(opened[2].replica.docId).toBe(docId)
    expect(opened[2].titles()).toEqual(['Title', 'Agenda', 'Budget'])
    expect(relayed.at(-1)).toEqual(['Title', 'Agenda', 'Budget'])
  })

  it('keeps the slides once when the file won over the saved replica, twice each way', async () => {
    await mount()
    opened[0].edit('Budget')
    // Saved with the file, but the file keeps its old content (a host that kept no saved file).
    await opened[0].saveReplica()
    opened[0].edit('Plan')
    const titles = ['Title', 'Agenda', 'Budget', 'Plan']

    for (const readOnly of [true, false, true, false]) {
      await act(async () => setReadOnlyDocuments(readOnly ? [PATH] : []))
      await settle()
      const current = opened.filter((kit) => !kit.closed)
      expect(current).toHaveLength(1)
      expect(current[0].readOnly).toBe(readOnly)
      expect(current[0].titles()).toEqual(titles)
    }
    expect(container.querySelectorAll('iframe')).toHaveLength(1)
  })
})
