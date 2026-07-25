import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ScenarioDraftAttachment } from '@/features/scenario/types'

import { ScenarioInput } from './ScenarioInput'

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

function makeAttachment(id = 'a-1'): ScenarioDraftAttachment {
  return {
    id,
    file: new File(['x'], `${id}.png`, { type: 'image/png' }),
    previewUrl: 'blob:mock',
  }
}

interface PartialProps {
  prompt?: string
  attachments?: ScenarioDraftAttachment[]
  onPromptChange?: (value: string) => void
  onRemoveAttachment?: (id: string) => void
  onPickAttachments?: () => void
  onOpenSetup?: () => void
  onSubmit?: () => void
  submitting?: boolean
}

function renderInput(props: PartialProps = {}) {
  return createElement(ScenarioInput, {
    prompt: props.prompt ?? '',
    attachments: props.attachments ?? [],
    onPromptChange: props.onPromptChange ?? vi.fn(),
    onRemoveAttachment: props.onRemoveAttachment ?? vi.fn(),
    onPickAttachments: props.onPickAttachments ?? vi.fn(),
    onOpenSetup: props.onOpenSetup,
    onSubmit: props.onSubmit ?? vi.fn(),
    submitting: props.submitting,
  })
}

function getSubmitButton() {
  return container.querySelector(
    '[data-testid="scenario-start-button"]',
  ) as HTMLButtonElement | null
}

function getTextarea() {
  return container.querySelector(
    '[data-testid="scenario-prompt-input"]',
  ) as HTMLTextAreaElement | null
}

async function pressKeyOnTextarea(
  init: { key: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean },
) {
  const ta = getTextarea()!
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...init,
  })
  await act(async () => {
    ta.dispatchEvent(event)
  })
  return event
}

describe('ScenarioInput', () => {
  beforeEach(async () => {
    await unmount()
  })

  it('disables Start it when prompt is empty and no attachments', async () => {
    await mount(renderInput({ prompt: '', attachments: [] }))
    const btn = getSubmitButton()
    expect(btn).not.toBeNull()
    expect(btn!.disabled).toBe(true)
  })

  it('enables Start it when the prompt has text (no attachments)', async () => {
    await mount(renderInput({ prompt: 'Build me an inbox', attachments: [] }))
    expect(getSubmitButton()!.disabled).toBe(false)
  })

  it('enables Start it when attachments are present (no prompt)', async () => {
    await mount(renderInput({ prompt: '', attachments: [makeAttachment()] }))
    expect(getSubmitButton()!.disabled).toBe(false)
  })

  it('clicking Start it invokes onSubmit', async () => {
    const onSubmit = vi.fn()
    await mount(renderInput({ prompt: 'hello', onSubmit }))
    await act(async () => {
      getSubmitButton()!.click()
    })
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('plain Enter in the textarea does NOT submit', async () => {
    const onSubmit = vi.fn()
    await mount(renderInput({ prompt: 'hello', onSubmit }))
    const event = await pressKeyOnTextarea({ key: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()
    // and not preventDefault'd — leaving the textarea's newline behavior intact.
    expect(event.defaultPrevented).toBe(false)
  })

  it('Cmd+Enter (metaKey) submits', async () => {
    const onSubmit = vi.fn()
    await mount(renderInput({ prompt: 'hello', onSubmit }))
    const event = await pressKeyOnTextarea({ key: 'Enter', metaKey: true })
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
  })

  it('Ctrl+Enter submits', async () => {
    const onSubmit = vi.fn()
    await mount(renderInput({ prompt: 'hello', onSubmit }))
    await pressKeyOnTextarea({ key: 'Enter', ctrlKey: true })
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('Cmd+Enter does NOT submit when the form is empty', async () => {
    const onSubmit = vi.fn()
    await mount(renderInput({ prompt: '', attachments: [], onSubmit }))
    await pressKeyOnTextarea({ key: 'Enter', metaKey: true })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('submitting=true disables the button regardless of content', async () => {
    await mount(
      renderInput({
        prompt: 'a thoughtful prompt',
        attachments: [makeAttachment()],
        submitting: true,
      }),
    )
    expect(getSubmitButton()!.disabled).toBe(true)
  })

  it('typing in the textarea calls onPromptChange', async () => {
    const onPromptChange = vi.fn()
    await mount(renderInput({ prompt: '', onPromptChange }))
    const ta = getTextarea()!
    await act(async () => {
      // emulate React-controlled change
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )!.set!
      setter.call(ta, 'hi')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(onPromptChange).toHaveBeenCalledWith('hi')
  })

  it('clicking the attachment icon calls onPickAttachments', async () => {
    const onPickAttachments = vi.fn()
    await mount(renderInput({ onPickAttachments }))
    const btn = container.querySelector(
      '[data-testid="scenario-pick-attachments"]',
    ) as HTMLButtonElement
    expect(btn).not.toBeNull()
    await act(async () => {
      btn.click()
    })
    expect(onPickAttachments).toHaveBeenCalledTimes(1)
  })

  it('renders one chip per attachment with a working remove handler', async () => {
    const onRemoveAttachment = vi.fn()
    const a = makeAttachment('one')
    const b = makeAttachment('two')
    await mount(renderInput({ attachments: [a, b], onRemoveAttachment }))
    const chips = container.querySelectorAll('[data-testid="scenario-chip"]')
    expect(chips.length).toBe(2)
    const removeBtns = container.querySelectorAll(
      '[data-testid="scenario-chip-remove"]',
    )
    await act(async () => {
      (removeBtns[1] as HTMLButtonElement).click()
    })
    expect(onRemoveAttachment).toHaveBeenCalledWith('two')
  })
})
