import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TriggerPicker } from './TriggerPicker'

let container: HTMLDivElement; let root: Root | null = null

async function mount(node: ReturnType<typeof createElement>) {
  await act(async () => { root = createRoot(container); root.render(node); await Promise.resolve() })
}

beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container) })
afterEach(() => { root?.unmount(); container.remove() })

describe('TriggerPicker', () => {
  it('renders 6 options', async () => {
    await mount(createElement(TriggerPicker, { onPick: () => {} }))
    expect(container.querySelectorAll('[data-testid^="trigger-option-"]').length).toBe(6)
  })

  it('disables unimplemented triggers', async () => {
    await mount(createElement(TriggerPicker, { onPick: () => {} }))
    // button_clicked is still gated. scheduled_time was unlocked alongside
    // the cron dispatcher landing — the "At scheduled time → Add record"
    // Feishu template exercises this path. record_updated was unlocked
    // alongside the runner subscription change. record_date_reached is
    // enabled (it's exposed via the Feishu-style "At record's trigger
    // time" template); the runtime dispatcher behind it is the
    // record-date-driven TimeDispatcher.
    expect(container.querySelector('[data-testid="trigger-option-button_clicked"]')?.getAttribute('aria-disabled')).toBe('true')
    expect(container.querySelector('[data-testid="trigger-option-scheduled_time"]')?.getAttribute('aria-disabled')).toBe('false')
    expect(container.querySelector('[data-testid="trigger-option-record_updated"]')?.getAttribute('aria-disabled')).toBe('false')
    expect(container.querySelector('[data-testid="trigger-option-record_created"]')?.getAttribute('aria-disabled')).toBe('false')
    expect(container.querySelector('[data-testid="trigger-option-record_date_reached"]')?.getAttribute('aria-disabled')).toBe('false')
  })

  it('calls onPick with chosen trigger type', async () => {
    const onPick = vi.fn()
    await mount(createElement(TriggerPicker, { onPick }))
    container.querySelector('[data-testid="trigger-option-record_updated"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onPick).toHaveBeenCalledWith('record_updated')
  })

  it("emits record_date_reached when the Feishu-style \"At record's trigger time\" option is picked", async () => {
    const onPick = vi.fn()
    await mount(createElement(TriggerPicker, { onPick }))
    container.querySelector('[data-testid="trigger-option-record_date_reached"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onPick).toHaveBeenCalledWith('record_date_reached')
  })

  it('emits scheduled_time when the "At scheduled time" option is picked', async () => {
    const onPick = vi.fn()
    await mount(createElement(TriggerPicker, { onPick }))
    container.querySelector('[data-testid="trigger-option-scheduled_time"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onPick).toHaveBeenCalledWith('scheduled_time')
  })
})
