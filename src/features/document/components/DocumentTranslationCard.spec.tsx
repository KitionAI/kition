import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DocumentTranslationState } from '@/features/document/hooks/useDocumentTranslation'

import { DocumentTranslationCard, type DocumentTranslationCardProps } from './DocumentTranslationCard'

let host: HTMLDivElement
let tooltip: HTMLDivElement
let root: Root | null = null

const ready: DocumentTranslationState = {
  status: 'ready',
  source: 'Hello',
  target: 'fr',
  result: 'Bonjour',
  error: null,
  errorMessage: '',
  stale: false,
}

function handlers() {
  return {
    onClose: vi.fn(),
    onRetry: vi.fn(),
    onChangeTarget: vi.fn(),
    onReplace: vi.fn(),
    onInsertBelow: vi.fn(),
    onCopy: vi.fn(async () => true),
    onConfigureModel: vi.fn(),
  }
}

async function render(props: Partial<DocumentTranslationCardProps> & { state: DocumentTranslationState }) {
  const all = { container: tooltip, ...handlers(), ...props } as DocumentTranslationCardProps
  await act(async () => {
    root ??= createRoot(host)
    root.render(createElement(DocumentTranslationCard, all))
  })
  return all
}

const query = (testId: string) => tooltip.querySelector<HTMLElement>(`[data-testid="${testId}"]`)

beforeEach(() => {
  host = document.createElement('div')
  tooltip = document.createElement('div')
  document.body.append(host, tooltip)
})

afterEach(async () => {
  await act(async () => { root?.unmount() })
  root = null
  host.remove()
  tooltip.remove()
})

describe('DocumentTranslationCard', () => {
  it('renders into the editor tooltip and focuses Replace when the result is ready', async () => {
    const props = await render({ state: ready })
    expect(query('document-translation-result')?.textContent).toBe('Bonjour')
    expect(document.activeElement).toBe(query('document-translation-replace'))

    act(() => query('document-translation-replace')!.click())
    expect(props.onReplace).toHaveBeenCalledTimes(1)
    act(() => query('document-translation-insert')!.click())
    expect(props.onInsertBelow).toHaveBeenCalledTimes(1)
  })

  it('handles Escape and Cmd+Enter inside the card', async () => {
    const props = await render({ state: ready })
    const card = query('document-translation-card')!
    act(() => { card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true })) })
    expect(props.onInsertBelow).toHaveBeenCalledTimes(1)
    act(() => { card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('disables Replace when the source text changed', async () => {
    await render({ state: { ...ready, stale: true } })
    expect((query('document-translation-replace') as HTMLButtonElement).disabled).toBe(true)
  })

  it('offers Configure model when no model is set up', async () => {
    const props = await render({ state: { ...ready, status: 'error', result: '', error: 'model' } })
    expect(query('document-translation-error')).not.toBeNull()
    const configure = Array.from(tooltip.querySelectorAll('button')).find((button) => button.textContent === 'Configure model')
    act(() => configure!.click())
    expect(props.onConfigureModel).toHaveBeenCalledTimes(1)
  })

  it('renders nothing without a tooltip container', async () => {
    await render({ state: ready, container: null })
    expect(query('document-translation-card')).toBeNull()
  })
})
