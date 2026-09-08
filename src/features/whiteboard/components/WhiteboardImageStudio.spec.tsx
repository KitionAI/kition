import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WhiteboardImageStudio } from './WhiteboardImageStudio'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container.remove()
  vi.restoreAllMocks()
})

describe('WhiteboardImageStudio', () => {
  it('opens with real visual examples before asking for prompt details', async () => {
    await renderStudio()

    expect(templateCards()).toHaveLength(6)
    expect(container.querySelector(
      '[data-testid="whiteboard-image-template-surreal-city-poster"] img',
    )?.getAttribute('src')).toContain('.webp')
    expect(container.querySelector('[data-testid="whiteboard-image-variable-subject"]')).toBeNull()

    await click('[data-testid="whiteboard-image-template-view-all"]')
    expect(templateCards()).toHaveLength(16)
  })

  it('reduces generation to template variables and folded advanced settings', async () => {
    await renderStudio(undefined, { selectionText: 'Alpha', sourceImagePaths: [] })
    await click('[data-testid="whiteboard-image-template-surreal-city-poster"]')

    expect((container.querySelector(
      '[data-testid="whiteboard-image-variable-subject"]',
    ) as HTMLInputElement).value).toBe('Alpha')
    expect(container.querySelector('details[data-testid="whiteboard-image-advanced-settings"]')?.hasAttribute('open')).toBe(false)
    expect(container.querySelector('[data-testid="whiteboard-image-exact-text"]')).not.toBeNull()
  })

  it('marks image-edit templates before the user enters the generator', async () => {
    await renderStudio()
    await click('[data-testid="whiteboard-image-template-view-edit"]')

    const template = container.querySelector(
      '[data-testid="whiteboard-image-template-mixed-media-memory-card"]',
    ) as HTMLButtonElement
    expect(template.textContent).toContain('Select an image on the Board')
    await act(async () => template.click())

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('needs a source image')
    expect((container.querySelector(
      '[data-testid="whiteboard-image-generate"]',
    ) as HTMLButtonElement).disabled).toBe(true)
  })

  it('confirms when a generated result has been added to the Board', async () => {
    await renderStudio({ paths: ['Agent/generated.png'], status: 'ready' })
    await click('[data-testid="whiteboard-image-template-surreal-city-poster"]')
    const add = container.querySelector(
      '[data-testid="whiteboard-image-add-0"]',
    ) as HTMLButtonElement

    await act(async () => add.click())

    expect(add.disabled).toBe(true)
    expect(add.textContent).toContain('Added')
  })
})

async function renderStudio(
  generation: {
    paths: string[]
    status: 'idle' | 'submitting' | 'generating' | 'ready' | 'error'
  } = { paths: [], status: 'idle' },
  context: { selectionText: string; sourceImagePaths: string[] } = {
    selectionText: '',
    sourceImagePaths: [],
  },
) {
  root = createRoot(container)
  await act(async () => {
    root?.render(createElement(WhiteboardImageStudio, {
      available: true,
      boardPath: 'Boards/Launch.kiboard',
      context,
      generation,
      onAddAll: vi.fn(),
      onAddResult: vi.fn(),
      onClose: vi.fn(),
      onGenerate: vi.fn().mockResolvedValue({ accepted: true }),
      onReplaceResult: vi.fn(),
      open: true,
    }))
  })
}

async function click(selector: string) {
  const element = container.querySelector(selector) as HTMLButtonElement
  await act(async () => element.click())
}

function templateCards() {
  return Array.from(container.querySelectorAll(
    'button[data-testid^="whiteboard-image-template-"]',
  )).filter((element) => (
    !element.getAttribute('data-testid')?.includes('-view-')
      && !element.getAttribute('data-testid')?.includes('-category-')
  ))
}
