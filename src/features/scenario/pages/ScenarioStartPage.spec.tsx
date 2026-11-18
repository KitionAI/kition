import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ScenarioStartPage } from './ScenarioStartPage'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root | null = null

const createObjectURL = vi.fn()
const revokeObjectURL = vi.fn()
let createCount = 0

beforeEach(() => {
  createCount = 0
  createObjectURL.mockImplementation(() => `blob:mock-${++createCount}`)
  revokeObjectURL.mockImplementation(() => {})
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL,
    revokeObjectURL,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

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
 * exposes the surface this component reads: `.types`, `.files`.
 */
function buildFakeDataTransfer(files: File[]): DataTransfer {
  const fakeFileList = {
    length: files.length,
    item: (i: number) => files[i] ?? null,
    [Symbol.iterator]: function* () {
      for (const f of files) yield f
    },
  } as unknown as FileList
  for (let i = 0; i < files.length; i += 1) {
    (fakeFileList as any)[i] = files[i]
  }
  const types: string[] = []
  if (files.length > 0) types.push('Files')
  return {
    files: fakeFileList,
    items: { length: files.length } as any,
    types,
    getData: () => '',
    setData: () => {},
    clearData: () => {},
    dropEffect: 'copy' as const,
    effectAllowed: 'all' as const,
    setDragImage: () => {},
  } as unknown as DataTransfer
}

function buildFileDataTransfer(files: File[]): DataTransfer {
  return buildFakeDataTransfer(files)
}

async function dispatchWindow(
  type: 'dragenter' | 'drop',
  dataTransfer: DataTransfer,
) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', {
    value: dataTransfer,
    configurable: true,
  })
  await act(async () => {
    window.dispatchEvent(event)
  })
}

describe('ScenarioStartPage', () => {
  beforeEach(async () => {
    await unmount()
  })

  it('renders the "Start from your scenario" heading', async () => {
    await mount(createElement(ScenarioStartPage, { onSubmit: vi.fn() }))
    const heading = container.querySelector(
      '[data-testid="scenario-heading"]',
    )
    expect(heading).not.toBeNull()
    expect(heading!.textContent).toContain('Start from your scenario')
  })

  it('shows zero chips initially', async () => {
    await mount(createElement(ScenarioStartPage, { onSubmit: vi.fn() }))
    expect(
      container.querySelectorAll('[data-testid="scenario-chip"]').length,
    ).toBe(0)
  })

  it('dropping 2 files renders 2 chips', async () => {
    await mount(createElement(ScenarioStartPage, { onSubmit: vi.fn() }))
    const f1 = new File(['x'], 'a.png', { type: 'image/png' })
    const f2 = new File(['y'], 'b.pdf', { type: 'application/pdf' })
    await dispatchWindow('dragenter', buildFileDataTransfer([f1, f2]))
    await dispatchWindow('drop', buildFileDataTransfer([f1, f2]))
    const chips = container.querySelectorAll('[data-testid="scenario-chip"]')
    expect(chips.length).toBe(2)
  })

  it('removing a chip drops it from the list and revokes its object URL', async () => {
    await mount(createElement(ScenarioStartPage, { onSubmit: vi.fn() }))
    const f1 = new File(['x'], 'a.png', { type: 'image/png' })
    await dispatchWindow('dragenter', buildFileDataTransfer([f1]))
    await dispatchWindow('drop', buildFileDataTransfer([f1]))
    expect(
      container.querySelectorAll('[data-testid="scenario-chip"]').length,
    ).toBe(1)
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    const removeBtn = container.querySelector(
      '[data-testid="scenario-chip-remove"]',
    ) as HTMLButtonElement
    await act(async () => {
      removeBtn.click()
    })
    expect(
      container.querySelectorAll('[data-testid="scenario-chip"]').length,
    ).toBe(0)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-1')
  })

  it('does NOT create an object URL for non-image files', async () => {
    await mount(createElement(ScenarioStartPage, { onSubmit: vi.fn() }))
    const pdf = new File(['x'], 'note.pdf', { type: 'application/pdf' })
    await dispatchWindow('dragenter', buildFileDataTransfer([pdf]))
    await dispatchWindow('drop', buildFileDataTransfer([pdf]))
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(
      container.querySelectorAll('[data-testid="scenario-chip"]').length,
    ).toBe(1)
  })

  it('clicking Start it invokes onSubmit with (prompt, files[])', async () => {
    const onSubmit = vi.fn()
    await mount(createElement(ScenarioStartPage, { onSubmit }))
    const f1 = new File(['x'], 'a.png', { type: 'image/png' })
    await dispatchWindow('dragenter', buildFileDataTransfer([f1]))
    await dispatchWindow('drop', buildFileDataTransfer([f1]))

    // type into the textarea
    const ta = container.querySelector(
      '[data-testid="scenario-prompt-input"]',
    ) as HTMLTextAreaElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )!.set!
      setter.call(ta, 'hello prompt')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const btn = container.querySelector(
      '[data-testid="scenario-start-button"]',
    ) as HTMLButtonElement
    await act(async () => {
      btn.click()
    })
    expect(onSubmit).toHaveBeenCalledTimes(1)
    const args = onSubmit.mock.calls[0]
    expect(args[0]).toBe('hello prompt')
    expect(Array.isArray(args[1])).toBe(true)
    expect((args[1] as File[]).length).toBe(1)
    expect((args[1] as File[])[0].name).toBe('a.png')
  })

  it('unmount revokes all outstanding object URLs', async () => {
    await mount(createElement(ScenarioStartPage, { onSubmit: vi.fn() }))
    const f1 = new File(['x'], 'a.png', { type: 'image/png' })
    const f2 = new File(['y'], 'b.jpg', { type: 'image/jpeg' })
    await dispatchWindow('dragenter', buildFileDataTransfer([f1, f2]))
    await dispatchWindow('drop', buildFileDataTransfer([f1, f2]))
    expect(createObjectURL).toHaveBeenCalledTimes(2)
    await unmount()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-1')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-2')
  })
})
