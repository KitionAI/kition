import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentComposerContext } from './AgentComposerContext'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
let container: HTMLDivElement
afterEach(async () => { await act(async () => root?.unmount()); container?.remove() })
async function mount(props: Parameters<typeof AgentComposerContext>[0]) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root!.render(createElement(AgentComposerContext, props)))
}

describe('Composer context control', () => {
  it('uses no space without references', async () => {
    await mount({ documents: [], sources: [], onRemoveDocument: vi.fn() })
    expect(container.childElementCount).toBe(0)
  })

  it('exposes every reference inline for opening or removal', async () => {
    const onOpenPath = vi.fn()
    const onRemoveDocument = vi.fn()
    const onRemoveSource = vi.fn()
    await mount({
      documents: [{ path: 'Docs/Current.md', current: true }, { path: 'Docs/Brief.md' }],
      sources: [{ id: 'project', label: 'project', root_path: '/example/project', access: 'read' }],
      onOpenPath, onRemoveDocument, onRemoveSource,
    })
    const content = container.querySelector<HTMLElement>('[role="list"]')!
    expect(content.querySelectorAll('[role="listitem"]')).toHaveLength(3)
    expect(content.textContent).toContain('Current.md')
    expect(content.textContent).toContain('Brief.md')
    expect(content.textContent).toContain('project')
    expect(content.querySelector('[aria-label="Read-only analysis source"]')).not.toBeNull()
    await act(async () => {
      content.querySelector<HTMLButtonElement>('[title="Docs/Brief.md"]')?.click()
      content.querySelector<HTMLButtonElement>('[aria-label="Remove Current.md"]')?.click()
      content.querySelector<HTMLButtonElement>('[aria-label="Remove project"]')?.click()
    })
    expect(onOpenPath).toHaveBeenCalledWith('Docs/Brief.md')
    expect(onRemoveDocument).toHaveBeenCalledWith('Docs/Current.md')
    expect(onRemoveSource).toHaveBeenCalledWith('project')
  })

  it('keeps references inspectable but prevents removal during a run', async () => {
    const remove = vi.fn()
    await mount({ documents: [{ path: 'Notes.md' }], sources: [], disabled: true, onRemoveDocument: remove })
    const button = document.querySelector<HTMLButtonElement>('[aria-label="Remove Notes.md"]')!
    expect(button.disabled).toBe(true)
    await act(async () => button.click())
    expect(remove).not.toHaveBeenCalled()
  })
})
