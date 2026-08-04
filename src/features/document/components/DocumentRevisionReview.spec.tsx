import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createDocumentRevisionComparison, type PendingDocumentRevision } from '@/features/document/lib/documentRevision'
import { DocumentRevisionReview } from './DocumentRevisionReview'

let container: HTMLDivElement
let root: Root | null = null

function createRevision(): PendingDocumentRevision {
  const originalDocument = {
    path: 'notes/example.md',
    name: 'example.md',
    content: 'Old paragraph.\nStable.\nOld ending.\n',
    format: 'markdown' as const,
  }
  const proposedDocument = {
    ...originalDocument,
    content: 'New paragraph.\nStable.\nNew ending.\n',
  }
  return {
    path: originalDocument.path,
    originalDocument,
    proposedDocument,
    comparison: createDocumentRevisionComparison(originalDocument.content, proposedDocument.content),
    decisions: {},
  }
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container.remove()
})

describe('DocumentRevisionReview', () => {
  it('shows the full document as continuous context with changed rows', () => {
    const revision = createRevision()
    const onDecideChange = vi.fn()
    act(() => {
      root = createRoot(container)
      root.render(createElement(DocumentRevisionReview, {
        revision,
        saving: false,
        onDecideChange,
        onResolveAll: vi.fn(),
      }))
    })

    expect(container.querySelectorAll('.document-revision-change-block')).toHaveLength(2)
    expect(container.querySelector('.document-revision-line.is-removed')?.textContent).toContain('Old paragraph.')
    expect(container.querySelector('.document-revision-line.is-added')?.textContent).toContain('New paragraph.')
    expect(container.textContent).toContain('Stable.')
    expect(Array.from(container.querySelectorAll('.document-revision-line__text')).map((line) => line.textContent))
      .toEqual(['Old paragraph.', 'New paragraph.', 'Stable.', 'Old ending.', 'New ending.'])
    expect(Array.from(container.querySelectorAll('.document-revision-line__number')).map((line) => line.textContent))
      .toEqual(['1', '1', '2', '3', '3'])

    const firstAccept = container.querySelector('button[aria-label="Accept change"]') as HTMLButtonElement
    act(() => firstAccept.click())
    expect(onDecideChange).toHaveBeenCalledWith('change-1', 'accepted')
  })

  it('supports accepting or rejecting every change', () => {
    const onResolveAll = vi.fn()
    act(() => {
      root = createRoot(container)
      root.render(createElement(DocumentRevisionReview, {
        revision: createRevision(),
        saving: false,
        onDecideChange: vi.fn(),
        onResolveAll,
      }))
    })

    const buttons = Array.from(container.querySelectorAll('button'))
    act(() => buttons.find((button) => button.textContent?.includes('Accept all'))?.click())
    expect(onResolveAll).toHaveBeenCalledWith('accepted')
    act(() => buttons.find((button) => button.textContent?.includes('Reject all'))?.click())
    expect(onResolveAll).toHaveBeenCalledWith('rejected')
  })

  it('keeps change navigation inside the review pane without stealing focus', () => {
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value(this: HTMLElement) {
        const top = this.classList.contains('document-revision-review__scroller') ? 100 : 600
        const height = this.classList.contains('document-revision-review__scroller') ? 400 : 40
        return {
          x: 0,
          y: top,
          top,
          right: 100,
          bottom: top + height,
          left: 0,
          width: 100,
          height,
          toJSON: () => ({}),
        } as DOMRect
      },
    })

    try {
      act(() => {
        root = createRoot(container)
        root.render(createElement(DocumentRevisionReview, {
          revision: createRevision(),
          saving: false,
          onDecideChange: vi.fn(),
          onResolveAll: vi.fn(),
        }))
      })

      const scroller = container.querySelector<HTMLElement>('.document-revision-review__scroller')
      const nextChange = container.querySelector<HTMLButtonElement>('button[aria-label="Next change"]')
      act(() => nextChange?.click())
      expect(scroller?.scrollTop).toBe(320)
      expect(document.activeElement).not.toBe(scroller)
    } finally {
      Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
        configurable: true,
        value: originalGetBoundingClientRect,
      })
    }
  })
})
