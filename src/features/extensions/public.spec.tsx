import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const documents = new Set<() => void>()
const changes = new Set<() => void>()
let active = false
let commandTitles: string[] = []

const subscribe = (listeners: Set<() => void>, listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

const service = {
  ready: Promise.resolve(),
  activeDocument: () => active ? { path: 'Screen.kdesign' } : null,
  subscribeDocuments: (listener: () => void) => subscribe(documents, listener),
  subscribe: (listener: () => void) => subscribe(changes, listener),
  paletteCommands: () => commandTitles.map((title) => ({ id: title, title, extension: 'example', extensionName: 'Example' })),
  palettePanels: () => [],
  runCommand: vi.fn(),
}

vi.mock('./serviceLoader', () => ({ loadExtensionService: async () => service }))
const { useExtensionPaletteItems } = await import('./public')

function Palette() {
  const items = useExtensionPaletteItems({ runScript: 'Run script', runScriptHint: 'Workspace script' })
  return createElement('ul', null, ...items.map((item) => createElement('li', { key: item.key }, item.title)))
}

let root: Root
let container: HTMLElement

beforeEach(() => {
  active = false
  commandTitles = []
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  documents.clear()
  changes.clear()
})

it('updates an open palette when the kit finishes opening or closes', async () => {
  await act(async () => root.render(createElement(Palette)))
  expect(container.textContent).toBe('')

  await act(async () => {
    active = true
    for (const listener of documents) listener()
  })
  expect(container.textContent).toBe('Run script')

  await act(async () => {
    active = false
    for (const listener of documents) listener()
  })
  expect(container.textContent).toBe('')
})

it('refreshes contributed commands and unsubscribes when the palette closes', async () => {
  active = true
  await act(async () => root.render(createElement(Palette)))
  expect(container.textContent).toBe('Run script')

  await act(async () => {
    commandTitles = ['Review document']
    for (const listener of changes) listener()
  })
  expect(container.textContent).toBe('Review documentRun script')
  await act(async () => root.render(null))
  expect(documents.size).toBe(0)
  expect(changes.size).toBe(0)
})
