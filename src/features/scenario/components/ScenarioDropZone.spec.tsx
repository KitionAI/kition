import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ScenarioDropZone } from './ScenarioDropZone'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root | null = null

async function mount(node: ReturnType<typeof createElement>) {
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container)
    root.render(node)
    await Promise.resolve()
  })
}

async function unmount() {
  await act(async () => {
    root?.unmount()
  })
  root = null
  container?.remove()
}

/**
 * jsdom does not implement `DataTransfer`, so build a minimal stand-in that
 * exposes the surface this component reads: `.types`, `.files`, `.items`.
 */
function buildFakeDataTransfer(
  options: { files?: File[]; text?: string } = {},
): DataTransfer {
  const files = options.files ?? []
  const fakeFileList = {
    length: files.length,
    item: (i: number) => files[i] ?? null,
    [Symbol.iterator]: function* () {
      for (const f of files) yield f
    },
  } as unknown as FileList
  // Index access
  for (let i = 0; i < files.length; i += 1) {
    (fakeFileList as any)[i] = files[i]
  }
  const types: string[] = []
  if (files.length > 0) types.push('Files')
  if (options.text != null) types.push('text/plain')
  return {
    files: fakeFileList,
    items: { length: files.length } as any,
    types,
    getData: (type: string) =>
      type === 'text/plain' && options.text != null ? options.text : '',
    setData: () => {},
    clearData: () => {},
    dropEffect: 'copy' as const,
    effectAllowed: 'all' as const,
    setDragImage: () => {},
  } as unknown as DataTransfer
}

function buildFileDataTransfer(files: File[]): DataTransfer {
  return buildFakeDataTransfer({ files })
}

function buildTextDataTransfer(text: string): DataTransfer {
  return buildFakeDataTransfer({ text })
}

async function dispatchWindow(
  type: 'dragenter' | 'dragover' | 'dragleave' | 'drop',
  dataTransfer: DataTransfer,
) {
  // jsdom's `DragEvent` ignores the `dataTransfer` init field, so build a
  // plain Event and define the getter ourselves.
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', {
    value: dataTransfer,
    configurable: true,
  })
  await act(async () => {
    window.dispatchEvent(event)
  })
}

function getOverlay() {
  return document.querySelector('[data-testid="scenario-dropzone-overlay"]')
}

describe('ScenarioDropZone', () => {
  beforeEach(async () => {
    await unmount()
  })

  it('renders children', async () => {
    await mount(
      createElement(
        ScenarioDropZone,
        { onFiles: vi.fn() },
        createElement('div', { 'data-testid': 'child' }, 'hello'),
      ),
    )
    expect(
      container.querySelector('[data-testid="child"]')?.textContent,
    ).toBe('hello')
  })

  it('shows the highlight overlay when dragenter brings files into the window', async () => {
    await mount(
      createElement(ScenarioDropZone, { onFiles: vi.fn() }, null),
    )
    expect(getOverlay()).toBeNull()
    const file = new File(['a'], 'a.png', { type: 'image/png' })
    await dispatchWindow('dragenter', buildFileDataTransfer([file]))
    expect(getOverlay()).not.toBeNull()
  })

  it('invokes onFiles with the dropped files', async () => {
    const onFiles = vi.fn()
    await mount(createElement(ScenarioDropZone, { onFiles }, null))
    const file1 = new File(['a'], 'a.png', { type: 'image/png' })
    const file2 = new File(['b'], 'b.pdf', { type: 'application/pdf' })
    await dispatchWindow('dragenter', buildFileDataTransfer([file1, file2]))
    await dispatchWindow('drop', buildFileDataTransfer([file1, file2]))
    expect(onFiles).toHaveBeenCalledTimes(1)
    const arg = onFiles.mock.calls[0][0] as File[]
    expect(arg.length).toBe(2)
    expect(arg[0].name).toBe('a.png')
    expect(arg[1].name).toBe('b.pdf')
  })

  it('removes the overlay once dragleave brings the counter back to zero', async () => {
    await mount(createElement(ScenarioDropZone, { onFiles: vi.fn() }, null))
    const file = new File(['a'], 'a.png', { type: 'image/png' })
    await dispatchWindow('dragenter', buildFileDataTransfer([file]))
    expect(getOverlay()).not.toBeNull()
    await dispatchWindow('dragleave', buildFileDataTransfer([file]))
    expect(getOverlay()).toBeNull()
  })

  it('does NOT highlight when a non-file payload is dragged', async () => {
    await mount(createElement(ScenarioDropZone, { onFiles: vi.fn() }, null))
    await dispatchWindow('dragenter', buildTextDataTransfer('hello'))
    expect(getOverlay()).toBeNull()
  })

  it('drop also clears the overlay highlight', async () => {
    await mount(createElement(ScenarioDropZone, { onFiles: vi.fn() }, null))
    const file = new File(['a'], 'a.png', { type: 'image/png' })
    await dispatchWindow('dragenter', buildFileDataTransfer([file]))
    await dispatchWindow('drop', buildFileDataTransfer([file]))
    expect(getOverlay()).toBeNull()
  })
})
