import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { loadTemplateContent, listTemplates } from '@/features/document/editor/vault/templates'
import { DocumentTemplateLibraryDialog } from './DocumentTemplateLibraryDialog'

vi.mock('@/features/document/editor/vault/templates', () => ({
  listTemplates: vi.fn(),
  loadTemplateContent: vi.fn(),
}))

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  vi.mocked(listTemplates).mockResolvedValue([])
  vi.mocked(loadTemplateContent).mockResolvedValue(null)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container.remove()
  vi.clearAllMocks()
})

async function mount(onCreate = vi.fn().mockResolvedValue(true)) {
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(DocumentTemplateLibraryDialog, {
      open: true,
      onOpenChange: vi.fn(),
      onCreate,
    }))
    await Promise.resolve()
  })
  return onCreate
}

describe('DocumentTemplateLibraryDialog', () => {
  it('shows a blank document and the built-in template library', async () => {
    await mount()

    expect(document.body.textContent).toContain('Template Center')
    const dialog = document.querySelector('[data-testid="document-template-library-dialog"]')
    expect(dialog?.className).toContain('md:w-[min(1040px')
    expect(dialog?.className).not.toContain('md:w-full')
    expect(document.body.textContent).toContain('New Markdown document')
    expect(document.querySelectorAll('button[data-testid^="workspace-template-category-"]').length).toBe(5)
    expect(document.querySelector('[data-testid="document-template-blank"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="document-template-project-brief"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="document-template-task-tracker"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="document-template-weekly-review"]')).not.toBeNull()
  })

  it('creates a blank document without a template preset', async () => {
    const onCreate = await mount()

    await act(async () => {
      const blankButton = document.querySelector('[data-testid="document-template-blank"]') as HTMLButtonElement
      blankButton.click()
      await Promise.resolve()
    })

    expect(onCreate).toHaveBeenCalledWith()
  })

  it('creates a document with the selected built-in template content', async () => {
    const onCreate = await mount()

    await act(async () => {
      const templateButton = document.querySelector('[data-testid="document-template-task-tracker"]') as HTMLButtonElement
      templateButton.click()
      await Promise.resolve()
    })

    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Task tracker',
      templateId: 'task-tracker',
      content: expect.stringContaining('| Task | Owner | Priority | Due date | Status |'),
    }))
  })

  it('loads personal templates from the workspace Templates folder', async () => {
    vi.mocked(listTemplates).mockResolvedValue([
      { name: 'Decision record', path: 'Templates/Decision record.md' },
    ])
    vi.mocked(loadTemplateContent).mockResolvedValue('# Decision record\n\nCreated today')
    const onCreate = await mount()

    await act(async () => {
      const templateButton = document.querySelector('[data-testid="document-template-workspace"]') as HTMLButtonElement
      templateButton.click()
      await Promise.resolve()
    })

    expect(loadTemplateContent).toHaveBeenCalledWith('Templates/Decision record.md', 'Decision record')
    expect(onCreate).toHaveBeenCalledWith({
      title: 'Decision record',
      content: '# Decision record\n\nCreated today',
      templateId: 'workspace:Templates/Decision record.md',
    })
  })
})
