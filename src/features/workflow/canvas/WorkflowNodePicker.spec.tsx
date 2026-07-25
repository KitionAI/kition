import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WorkflowNodePicker } from './WorkflowNodePicker'

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  root?.unmount()
  root = null
  container.remove()
})

async function mount(onPick = vi.fn(), onClose = vi.fn()) {
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(WorkflowNodePicker, { onPick, onClose }))
    await Promise.resolve()
  })
  return { onPick, onClose }
}

describe('WorkflowNodePicker', () => {
  it('only invokes runnable actions and marks planned nodes disabled', async () => {
    const { onPick } = await mount()
    const update = document.querySelector('[data-node-type="update_record"]') as HTMLButtonElement
    const branch = document.querySelector('[data-node-type="if_else"]') as HTMLButtonElement

    expect(update.disabled).toBe(false)
    expect(branch.disabled).toBe(true)
    await act(async () => {
      update.click()
      branch.click()
      await Promise.resolve()
    })
    expect(onPick).toHaveBeenCalledOnce()
    expect(onPick).toHaveBeenCalledWith('update_record')
  })

  it('switches categories while keeping implemented and planned utility nodes distinct', async () => {
    await mount()
    const utilities = document.querySelector('[data-picker-tab="utilities"]') as HTMLButtonElement
    await act(async () => {
      utilities.click()
      await Promise.resolve()
    })

    expect(document.querySelector('[data-node-type="transform_record"]')).toBeTruthy()
    expect((document.querySelector('[data-node-type="javascript"]') as HTMLButtonElement).disabled).toBe(true)
    expect(document.querySelector('[data-node-type="update_record"]')).toBeNull()
  })

  it('closes on Escape and outside pointer interaction', async () => {
    const { onClose } = await mount()
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      await Promise.resolve()
    })
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
