import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** Each panel frame the service showed: on which opening of the document, and whether it went. */
type Shown = { opening: number | null; disposed: boolean }

const shown: Shown[] = []
const documents = new Set<() => void>()
let opening: number | null = null

const setOpening = (next: number | null) => {
  opening = next
  for (const listener of [...documents]) listener()
}

const fakeService = {
  getSnapshot: () => ({ ready: true, installed: [] }),
  subscribe: () => () => undefined,
  enabled: () => true,
  host: { panelsFor: () => [{ id: 'titles.panel', title: 'Titles', extension: 'com.example.titles', extensionName: 'Titles' }] },
  documentOpening: () => opening,
  subscribeDocuments: (listener: () => void) => {
    documents.add(listener)
    return () => {
      documents.delete(listener)
    }
  },
  showPanel: vi.fn(async () => {
    const frame: Shown = { opening, disposed: false }
    shown.push(frame)
    return {
      frame: document.createElement('iframe'),
      dispose: () => {
        frame.disposed = true
      },
    }
  }),
}

vi.mock('./serviceLoader', () => ({ loadExtensionService: async () => fakeService }))
vi.mock('@/features/kits/public', () => ({ kitionTheme: () => ({ tokens: {} }) }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

const { default: ExtensionPanel } = await import('./ExtensionPanel')

const PATH = 'Deck.pptx'
const OPEN = { extension: 'com.example.titles', panel: 'titles.panel' }

let root: Root | null = null
let container: HTMLElement

const settle = async () => {
  for (let i = 0; i < 5; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
}

const status = () => container.querySelector('[data-testid="extension-panel"]')?.getAttribute('data-status')

beforeEach(async () => {
  shown.length = 0
  fakeService.showPanel.mockClear()
  opening = 1
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(ExtensionPanel, { path: PATH, open: OPEN }))
  })
  await settle()
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container.remove()
  documents.clear()
})

describe('ExtensionPanel', () => {
  it('opens again on the editor a role change opens, and waits while none is open', async () => {
    expect(shown.map((frame) => frame.opening)).toEqual([1])
    expect(status()).toBe('open')

    // The editor closes (a role change): the panel waits for the next one.
    await act(async () => setOpening(null))
    await settle()
    expect(shown[0].disposed).toBe(true)
    expect(status()).toBe('opening')
    expect(fakeService.showPanel).toHaveBeenCalledTimes(1)

    // The editor opens again: the panel opens on it.
    await act(async () => setOpening(2))
    await settle()
    expect(shown.map((frame) => frame.opening)).toEqual([1, 2])
    expect(shown[1].disposed).toBe(false)
    expect(status()).toBe('open')
  })

  it('opens again when the editor is replaced without a gap', async () => {
    await act(async () => setOpening(3))
    await settle()
    expect(shown.map((frame) => [frame.opening, frame.disposed])).toEqual([
      [1, true],
      [3, false],
    ])
    expect(status()).toBe('open')
  })
})
