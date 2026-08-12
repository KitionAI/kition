import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

import { AgentContextTray } from './AgentContextTray'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

describe('AgentContextTray', () => {
  it('does not consume composer space when the context is empty', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => root.render(createElement(AgentContextTray, {
      documents: [],
      sources: [],
      onRemoveDocument: vi.fn(),
    })))

    expect(container.textContent).toBe('')
    expect(container.querySelector('.agent-context-tray')).toBeNull()

    await act(async () => root.unmount())
    container.remove()
  })

  it('unifies the current document, references, and local sources', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const onRemoveDocument = vi.fn()
    const onRemoveSource = vi.fn()

    await act(async () => root.render(createElement(AgentContextTray, {
      documents: [
        { path: 'Campaigns/Current.md', kind: 'file' },
        { path: 'Notes/Brief.md', kind: 'file' },
      ],
      sources: [{
        id: 'source-project',
        label: 'project',
        root_path: '/example/project',
        access: 'read',
      }],
      onRemoveDocument,
      onRemoveSource,
    })))

    expect(container.textContent).toContain('Current.md')
    expect(container.textContent).not.toContain('Current ·')
    expect(container.textContent).toContain('Brief.md')
    expect(container.textContent).toContain('project')
    expect(container.textContent).not.toContain('Analysis folder · 1')

    await act(async () => {
      const documentRemovers = container.querySelectorAll<HTMLButtonElement>(
        '.agent-context-chip.is-document .agent-context-chip__remove',
      )
      documentRemovers[0]?.click()
      documentRemovers[1]?.click()
      container.querySelector<HTMLButtonElement>('.agent-context-chip.is-source .agent-context-chip__remove')?.click()
    })
    expect(onRemoveDocument).toHaveBeenCalledWith('Campaigns/Current.md')
    expect(onRemoveDocument).toHaveBeenCalledWith('Notes/Brief.md')
    expect(onRemoveSource).toHaveBeenCalledWith('source-project')

    await act(async () => root.unmount())
    container.remove()
  })

  it('keeps every context item available inside the bounded item region', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const onRemoveDocument = vi.fn()

    await act(async () => root.render(createElement(AgentContextTray, {
      documents: Array.from({ length: 7 }, (_, index) => ({
        path: `References/Document-${index + 1}.md`,
        kind: 'file' as const,
      })),
      sources: [],
      onRemoveDocument,
    })))

    const itemRegion = container.querySelector('.agent-context-tray__items')
    expect(itemRegion).not.toBeNull()
    expect(itemRegion?.querySelectorAll('.agent-context-chip')).toHaveLength(7)

    await act(async () => {
      itemRegion?.querySelectorAll<HTMLButtonElement>('.agent-context-chip__remove')[6]?.click()
    })
    expect(onRemoveDocument).toHaveBeenCalledWith('References/Document-7.md')

    await act(async () => root.unmount())
    container.remove()
  })
})
