import { act, createElement, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentMentionableDocument } from '@/features/agent/lib/documentMentions'
import { AgentAiComposer } from './AgentAiComposer'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root | null = null

function makeDocument(path: string, title: string): AgentMentionableDocument {
  return {
    kind: 'file',
    path,
    name: `${title}.md`,
    title,
    format: 'markdown',
  }
}

function makeProps(
  extra: Partial<ComponentProps<typeof AgentAiComposer>> = {},
): ComponentProps<typeof AgentAiComposer> {
  return {
    busy: false,
    canSend: false,
    draft: '',
    mentionableDocuments: [],
    modelOptions: [],
    needsModelConfig: false,
    selectedModelKey: '',
    onConfigureModel: vi.fn(),
    onDraftChange: vi.fn(),
    onKeyDown: vi.fn(),
    onModelChange: vi.fn(),
    onSend: vi.fn(),
    onStop: vi.fn(),
    ...extra,
  }
}

async function mount(props: ComponentProps<typeof AgentAiComposer>) {
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(AgentAiComposer, props))
  })
}

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container?.remove()
})

describe('AgentAiComposer document mentions', () => {
  it('keeps the current attached document visible and marked', async () => {
    const current = makeDocument('Docs/Current.md', 'Current')
    await mount(makeProps({
      currentDocumentPath: current.path,
      documentContextPaths: [current.path],
      draft: '@',
      mentionableDocuments: [current, makeDocument('Docs/Other.md', 'Other')],
    }))

    const currentRow = container.querySelector<HTMLElement>(
      `[data-mention-path="${current.path}"]`,
    )
    expect(currentRow).not.toBeNull()
    expect(currentRow?.classList.contains('is-attached')).toBe(true)
    expect(currentRow?.textContent).toContain('Current')
    expect(currentRow?.textContent).toContain('Attached')
  })

  it('searches documents beyond the initial suggestion limit and adds the highlighted result', async () => {
    Element.prototype.scrollIntoView = vi.fn()
    const target = makeDocument('Archive/Needle.md', 'Needle')
    const documents = [
      ...Array.from({ length: 20 }, (_, index) => makeDocument(
        `Docs/Document-${index + 1}.md`,
        `Document ${index + 1}`,
      )),
      target,
    ]
    const onAddDocumentContext = vi.fn()
    const onDraftChange = vi.fn()
    await mount(makeProps({
      draft: '@Needle',
      mentionableDocuments: documents,
      onAddDocumentContext,
      onDraftChange,
    }))

    expect(container.querySelector(`[data-mention-path="${target.path}"]`)).not.toBeNull()
    expect(container.textContent).toContain('1 matching reference')

    const textarea = container.querySelector('textarea')
    await act(async () => {
      textarea?.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      }))
    })
    expect(onAddDocumentContext).toHaveBeenCalledWith(target.path)
    expect(onDraftChange).toHaveBeenCalledWith('')
  })

  it('shows a no-match state for an unknown document keyword', async () => {
    const onKeyDown = vi.fn()
    await mount(makeProps({
      draft: '@missing document',
      mentionableDocuments: [makeDocument('Docs/Plan.md', 'Plan')],
      onKeyDown,
    }))

    expect(container.querySelector('.agent-mention-menu__empty')?.textContent).toBe(
      'No matching workspace documents',
    )
    await act(async () => {
      container.querySelector('textarea')?.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      }))
    })
    expect(onKeyDown).toHaveBeenCalledOnce()
  })
})
