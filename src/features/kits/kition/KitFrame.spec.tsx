import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Opened = {
  /** The frame the kit was mounted in: a kit page answers one handshake, so each open needs its own. */
  element: unknown
  readOnly: boolean
  replica: string[]
  imports: string[]
  closed: boolean
  write: (params: { path: string; bytes: ArrayBuffer; mode: 'save' | 'new' }) => Promise<unknown>
  shortcuts: string[]
  shortcut: (key: { key: string; code: string; meta: boolean; ctrl: boolean; shift: boolean; alt: boolean }) => void
}

const encode = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer
const decode = (bytes: ArrayBuffer) => new TextDecoder().decode(bytes)

/** Every kit opened, oldest first: each keeps a replica of edit names, exported and imported as text. */
const opened: Opened[] = []

vi.mock('../host/mountKit', () => ({
  mountKit: vi.fn(async (element: unknown, options: { document: { readOnly?: boolean }; shortcuts: string[]; handlers: { write: Opened['write']; shortcut: Opened['shortcut'] } }) => {
    const kit: Opened = {
      element,
      readOnly: Boolean(options.document.readOnly),
      replica: [],
      imports: [],
      closed: false,
      write: options.handlers.write,
      shortcuts: options.shortcuts,
      shortcut: options.handlers.shortcut,
    }
    opened.push(kit)
    return {
      capabilities: ['replica'],
      close: () => {
        kit.closed = true
      },
      setLocale: () => undefined,
      focus: () => undefined,
      replica: {
        version: async () => encode(String(kit.replica.length)),
        exportChanges: async () => ({ changes: encode(kit.replica.join(',')), blobs: new ArrayBuffer(0) }),
        importChanges: async (changes: ArrayBuffer) => {
          const text = decode(changes)
          kit.imports.push(text)
          for (const edit of text.split(',').filter(Boolean)) if (!kit.replica.includes(edit)) kit.replica.push(edit)
        },
        info: async () => 'doc-1',
        onChanged: () => () => undefined,
      },
      ai: {},
    }
  }),
}))

vi.mock('./kitionHost', () => ({
  KITION_KIT_HOST: {
    read: async () => ({ bytes: new Uint8Array([1]), stamp: 'v1' }),
    stamp: async () => 'v1',
    lend: () => null,
  },
  readKitReplica: async () => null,
  writeKitReplica: async () => undefined,
}))

const writes: string[] = []
vi.mock('@/api/kits', () => ({ writeKitFile: vi.fn(async (path: string) => void writes.push(path)) }))
vi.mock('./kitBridge', () => ({ registerBridgeEditor: () => () => undefined, reportBridgeChange: () => undefined }))
vi.mock('./kitTestBridge', () => ({ registerKitTestFrame: () => () => undefined }))
vi.mock('./pickWorkspaceFile', () => ({ pickWorkspaceFile: async () => null }))

const relayed: string[][] = []
vi.mock('./kitConnections', () => ({
  // What co-editing would relay from: the replica the kit had when it was offered.
  registerKitConnection: vi.fn((document: { connection: { replica: { exportChanges: () => Promise<{ changes: ArrayBuffer }> } } }) => {
    void document.connection.replica.exportChanges().then(({ changes }) => relayed.push(decode(changes).split(',').filter(Boolean)))
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
    await mount()
    expect(opened.map((kit) => kit.readOnly)).toEqual([false])
    // Edits made while an editor, not saved (and not necessarily in the room yet).
    opened[0].replica.push('edit-1', 'edit-2')

    await act(async () => setReadOnlyDocuments([PATH]))
    await settle()

    expect(opened.map((kit) => kit.readOnly)).toEqual([false, true])
    expect(opened[0].closed).toBe(true)
    // The kit opened again is a new page in a new frame; the old frame is gone.
    expect(opened[1].element).not.toBe(opened[0].element)
    expect((opened[0].element as HTMLElement).isConnected).toBe(false)
    expect(container.querySelectorAll('iframe')).toHaveLength(1)
    expect(opened[1].replica).toEqual(['edit-1', 'edit-2'])
    // The kit opened again had the edits before co-editing was offered it.
    expect(relayed.at(-1)).toEqual(['edit-1', 'edit-2'])
    expect(writes).toEqual([])
  })

  it('opens the kit editable again when the role becomes editor, with what the viewer had', async () => {
    setReadOnlyDocuments([PATH])
    await mount()
    opened[0].replica.push('from-the-room')
    await act(async () => setReadOnlyDocuments([]))
    await settle()
    expect(opened.map((kit) => kit.readOnly)).toEqual([true, false])
    expect(opened[1].element).not.toBe(opened[0].element)
    expect(opened[1].replica).toEqual(['from-the-room'])
  })
})
