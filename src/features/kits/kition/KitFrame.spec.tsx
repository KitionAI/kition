import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { newDocId, parseSchema, person, randomActor, Replica, system, Version } from '@/lib/kdm'

type Opened = {
  /** The frame the kit was mounted in: a kit page answers one handshake, so each open needs its own. */
  element: unknown
  readOnly: boolean
  replica: Replica
  /** The deck's slide titles, as the kit's replica holds them. */
  titles: () => string[]
  /** An edit: a slide titled `title` added at the end. */
  edit: (title: string) => void
  /** Saves the replica with the file (the file itself stays as it is, as in a host that keeps no saved file). */
  saveReplica: () => Promise<void>
  imports: number
  closed: boolean
  write: (params: { path: string; bytes: ArrayBuffer; mode: 'save' | 'new' }) => Promise<unknown>
  shortcuts: string[]
  shortcut: (key: { key: string; code: string; meta: boolean; ctrl: boolean; shift: boolean; alt: boolean }) => void
}

const encode = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer
const decode = (bytes: ArrayBuffer) => new TextDecoder().decode(bytes)
const buffer = (bytes: Uint8Array) => bytes.slice().buffer as ArrayBuffer

/** A deck, as a kit keeps it in a real KDM replica: slides with titles. */
const deckSchema = parseSchema({
  kdm: 1,
  kit: 'kit.test',
  schemaVersion: 1,
  root: 'Deck',
  types: { Deck: { fields: { slides: { kind: 'list', of: 'Slide' } } }, Slide: { fields: { title: { kind: 'string' } } } },
})

const deckTitles = (replica: Replica) => {
  const [deck] = replica.objectsOfType('Deck')
  return replica.list(deck, 'slides').map((slide) => String(replica.get(slide, 'title')))
}

/** The file: the deck's titles as JSON (empty bytes: no file, the replica alone is the document). */
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
    shortcut: Opened['shortcut']
    replicaRead: (params: { path: string }) => Promise<{ snapshot: ArrayBuffer; blobs: ArrayBuffer; fileStamp: string } | null>
    replicaWrite: (params: { path: string; snapshot: ArrayBuffer; blobs: ArrayBuffer; fileStamp: string }) => Promise<void>
  }
}

/**
 * A kit as the standard's kits open a document: from the replica saved with the file when it was
 * saved with the file as it is now, else a new replica (a new document) made from the file. When
 * the saved replica does not hold the file's content, the file wins, recorded onto the replica as
 * new slides (as the Slides kit does).
 */
async function openFakeKit(element: unknown, options: FakeOptions): Promise<Opened> {
  const { document, handlers } = options
  const file = document.bytes.byteLength ? (JSON.parse(decode(document.bytes)) as string[]) : null
  const stored = await handlers.replicaRead({ path: document.path })
  const build = (titles: string[]) => (tx: Parameters<Parameters<Replica['transact']>[1]>[0], deck: string) => {
    for (const title of titles) tx.listInsert(deck, 'slides', tx.list(deck, 'slides').length, tx.create('Slide', { title }))
  }
  let replica: Replica
  if (stored && stored.fileStamp === document.version) {
    replica = Replica.load(deckSchema, new Uint8Array(stored.snapshot), randomActor())
    if (file && JSON.stringify(deckTitles(replica)) !== JSON.stringify(file)) {
      replica.transact(system('import'), (tx) => {
        const [deck] = replica.objectsOfType('Deck')
        for (let index = tx.list(deck, 'slides').length - 1; index >= 0; index -= 1) tx.listRemove(deck, 'slides', index)
        build(file)(tx, deck)
      })
    }
  } else {
    replica = Replica.createWith(deckSchema, newDocId(), randomActor(), system('create'), (tx) => build(file ?? [])(tx, tx.create('Deck', {}))).replica
  }
  return {
    element,
    readOnly: Boolean(document.readOnly),
    replica,
    titles: () => deckTitles(replica),
    edit: (title) => replica.transact(person('user:test'), (tx) => build([title])(tx, replica.objectsOfType('Deck')[0])),
    saveReplica: () => handlers.replicaWrite({ path: document.path, snapshot: buffer(replica.snapshot()), blobs: new ArrayBuffer(0), fileStamp: fileState.stamp }),
    imports: 0,
    closed: false,
    write: handlers.write,
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

vi.mock('./kitionHost', () => ({
  KITION_KIT_HOST: {
    read: async () => ({ bytes: encode(JSON.stringify(fileState.titles)), stamp: fileState.stamp }),
    stamp: async () => fileState.stamp,
    lend: () => null,
  },
  readKitReplica: async () => store.replica,
  writeKitReplica: async (_path: string, _kitId: string, replica: { snapshot: ArrayBuffer; blobs: ArrayBuffer; fileStamp: string }) => {
    store.replica = replica
  },
}))

const writes: string[] = []
vi.mock('@/api/kits', () => ({ writeKitFile: vi.fn(async (path: string) => void writes.push(path)) }))
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
  const replica = Replica.createWith(deckSchema, newDocId(), randomActor(), system('create'), (tx) => {
    const deck = tx.create('Deck', {})
    fileState.titles.forEach((title, index) => tx.listInsert(deck, 'slides', index, tx.create('Slide', { title })))
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
