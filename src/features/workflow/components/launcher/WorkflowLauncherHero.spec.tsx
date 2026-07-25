import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkflowLauncherHero } from './WorkflowLauncherHero'
import type { WorkflowLauncherHeroProps } from './WorkflowLauncherHero'

const baseGalleryProps: WorkflowLauncherHeroProps = {
  view: 'gallery',
  tableName: 'Leads',
  prompt: '',
  submitting: false,
  errorMessage: null,
  onPromptChange: () => {},
  onSwitchToAiPrompt: () => {},
  onSwitchToGallery: () => {},
  onAiSubmit: () => {},
  onStartFromScratch: () => {},
}

const baseAiProps: WorkflowLauncherHeroProps = {
  ...baseGalleryProps,
  view: 'ai-prompt',
}

let container: HTMLDivElement
let root: Root | null = null

async function mount(node: ReturnType<typeof createElement>) {
  await act(async () => { root = createRoot(container); root.render(node); await Promise.resolve() })
}

function queryByTestId(id: string) {
  return container.querySelector(`[data-testid="${id}"]`)
}

beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container) })
afterEach(() => { root?.unmount(); container.remove() })

describe('WorkflowLauncherHero', () => {
  describe('gallery view', () => {
    it('renders headline and both CTAs', async () => {
      await mount(createElement(WorkflowLauncherHero, baseGalleryProps))
      expect(container.textContent).toContain('Automate any task with workflows')
      expect(queryByTestId('workflow-launcher-cta-ai')).not.toBeNull()
      expect(queryByTestId('workflow-launcher-cta-scratch')).not.toBeNull()
    })

    it('AI CTA fires onSwitchToAiPrompt', async () => {
      const onSwitchToAiPrompt = vi.fn()
      await mount(createElement(WorkflowLauncherHero, { ...baseGalleryProps, onSwitchToAiPrompt }))
      queryByTestId('workflow-launcher-cta-ai')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      expect(onSwitchToAiPrompt).toHaveBeenCalled()
    })

    it('Scratch CTA fires onStartFromScratch', async () => {
      const onStartFromScratch = vi.fn()
      await mount(createElement(WorkflowLauncherHero, { ...baseGalleryProps, onStartFromScratch }))
      queryByTestId('workflow-launcher-cta-scratch')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      expect(onStartFromScratch).toHaveBeenCalled()
    })

    it('renders inline error when errorMessage is non-null', async () => {
      await mount(createElement(WorkflowLauncherHero, { ...baseGalleryProps, errorMessage: 'Something went wrong' }))
      const err = queryByTestId('workflow-model-error')
      expect(err).not.toBeNull()
      expect(err?.textContent).toContain('Something went wrong')
    })
  })

  describe('ai-prompt view', () => {
    it('shows textarea, submit button, and table chip with tableName', async () => {
      await mount(createElement(WorkflowLauncherHero, baseAiProps))
      expect(queryByTestId('workflow-prompt')).not.toBeNull()
      expect(queryByTestId('workflow-launcher-ai-submit')).not.toBeNull()
      const tableInput = queryByTestId('workflow-table-name') as HTMLInputElement | null
      expect(tableInput).not.toBeNull()
      expect(tableInput?.value).toBe('Leads')
    })

    it('submit button is disabled when prompt is empty', async () => {
      await mount(createElement(WorkflowLauncherHero, { ...baseAiProps, prompt: '' }))
      const submitBtn = queryByTestId('workflow-launcher-ai-submit') as HTMLButtonElement | null
      expect(submitBtn?.disabled).toBe(true)
    })

    it('Cmd/Ctrl+Enter fires onAiSubmit when prompt is non-empty', async () => {
      const onAiSubmit = vi.fn()
      await mount(createElement(WorkflowLauncherHero, { ...baseAiProps, prompt: 'send email', onAiSubmit }))
      const textarea = queryByTestId('workflow-prompt') as HTMLTextAreaElement
      await act(async () => {
        textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }))
        await Promise.resolve()
      })
      expect(onAiSubmit).toHaveBeenCalled()
    })

    it('back button fires onSwitchToGallery', async () => {
      const onSwitchToGallery = vi.fn()
      await mount(createElement(WorkflowLauncherHero, { ...baseAiProps, onSwitchToGallery }))
      queryByTestId('workflow-launcher-ai-back')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      expect(onSwitchToGallery).toHaveBeenCalled()
    })

    it('renders inline error when errorMessage is non-null', async () => {
      await mount(createElement(WorkflowLauncherHero, { ...baseAiProps, errorMessage: 'AI failed', prompt: 'hello' }))
      const err = queryByTestId('workflow-model-error')
      expect(err).not.toBeNull()
      expect(err?.textContent).toContain('AI failed')
    })
  })
})
