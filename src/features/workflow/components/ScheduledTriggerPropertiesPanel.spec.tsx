import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ScheduledTriggerPropertiesPanel,
  buildCron,
  parseCron,
} from './ScheduledTriggerPropertiesPanel'

let container: HTMLDivElement; let root: Root | null = null

async function mount(node: ReturnType<typeof createElement>) {
  await act(async () => { root = createRoot(container); root.render(node); await Promise.resolve() })
}

beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container) })
afterEach(() => { root?.unmount(); container.remove() })

describe('parseCron', () => {
  it('treats empty cron as a daily-9am default', () => {
    expect(parseCron('')).toEqual({ frequency: 'daily', timeOfDay: '09:00' })
  })

  it('parses daily 11am as the daily preset', () => {
    expect(parseCron('0 11 * * *')).toEqual({ frequency: 'daily', timeOfDay: '11:00' })
  })

  it('parses weekdays 9am as the weekdays preset', () => {
    expect(parseCron('0 9 * * 1-5')).toEqual({ frequency: 'weekdays', timeOfDay: '09:00' })
  })

  it('parses weekly-monday 8:30am as the weekly_monday preset', () => {
    expect(parseCron('30 8 * * 1')).toEqual({ frequency: 'weekly_monday', timeOfDay: '08:30' })
  })

  it('parses hourly-top-of-hour as the hourly preset', () => {
    expect(parseCron('0 * * * *')).toEqual({ frequency: 'hourly', timeOfDay: '' })
  })

  it('falls back to custom for non-preset shapes', () => {
    // Every 15 minutes during business hours — picker can't express this.
    expect(parseCron('*/15 9-17 * * 1-5')).toEqual({ frequency: 'custom', timeOfDay: '' })
  })

  it('falls back to custom for malformed cron', () => {
    expect(parseCron('this is not cron')).toEqual({ frequency: 'custom', timeOfDay: '' })
  })
})

describe('buildCron', () => {
  it('builds daily expression', () => {
    expect(buildCron({ frequency: 'daily', timeOfDay: '11:00' })).toBe('0 11 * * *')
  })

  it('builds weekdays expression', () => {
    expect(buildCron({ frequency: 'weekdays', timeOfDay: '09:00' })).toBe('0 9 * * 1-5')
  })

  it('builds weekly-monday expression', () => {
    expect(buildCron({ frequency: 'weekly_monday', timeOfDay: '08:30' })).toBe('30 8 * * 1')
  })

  it('builds hourly expression ignoring timeOfDay', () => {
    expect(buildCron({ frequency: 'hourly', timeOfDay: '' })).toBe('0 * * * *')
  })

  it('returns empty for the custom case (caller short-circuits before this)', () => {
    expect(buildCron({ frequency: 'custom', timeOfDay: '' })).toBe('')
  })
})

describe('ScheduledTriggerPropertiesPanel', () => {
  it('renders frequency + time + cron preview for daily', async () => {
    await mount(createElement(ScheduledTriggerPropertiesPanel, {
      cron: '0 11 * * *',
      onChange: () => {},
    }))
    const freq = container.querySelector('[data-testid="scheduled-trigger-frequency"]') as HTMLSelectElement
    expect(freq?.value).toBe('daily')
    const time = container.querySelector('[data-testid="scheduled-trigger-time"]') as HTMLInputElement
    expect(time?.value).toBe('11:00')
    const cronInput = container.querySelector('[data-testid="scheduled-trigger-cron"]') as HTMLInputElement
    expect(cronInput?.value).toBe('0 11 * * *')
    // Cron field is read-only when frequency is a preset.
    expect(cronInput?.disabled).toBe(true)
  })

  it('hides time-of-day for hourly preset', async () => {
    await mount(createElement(ScheduledTriggerPropertiesPanel, {
      cron: '0 * * * *',
      onChange: () => {},
    }))
    expect(container.querySelector('[data-testid="scheduled-trigger-time"]')).toBeNull()
  })

  it('enables the cron text field in custom mode', async () => {
    await mount(createElement(ScheduledTriggerPropertiesPanel, {
      cron: '*/15 9-17 * * 1-5',
      onChange: () => {},
    }))
    const cronInput = container.querySelector('[data-testid="scheduled-trigger-cron"]') as HTMLInputElement
    expect(cronInput?.disabled).toBe(false)
    expect(cronInput?.value).toBe('*/15 9-17 * * 1-5')
  })

  it('emits a new cron string when frequency changes', async () => {
    const onChange = vi.fn()
    await mount(createElement(ScheduledTriggerPropertiesPanel, {
      cron: '0 11 * * *',
      onChange,
    }))
    const freq = container.querySelector('[data-testid="scheduled-trigger-frequency"]') as HTMLSelectElement
    await act(async () => {
      freq.value = 'weekdays'
      freq.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onChange).toHaveBeenCalledWith({ cron: '0 11 * * 1-5', timezone: '' })
  })

  it('emits a new cron string when time-of-day changes', async () => {
    const onChange = vi.fn()
    await mount(createElement(ScheduledTriggerPropertiesPanel, {
      cron: '0 11 * * *',
      onChange,
    }))
    const time = container.querySelector('[data-testid="scheduled-trigger-time"]') as HTMLInputElement
    // React's __valueTracker monkey-patches HTMLInputElement.prototype.value;
    // assigning .value directly is detected as "already seen" and the
    // synthetic onChange is suppressed. Going through the original prototype
    // setter bypasses the tracker so React fires the handler.
    const nativeValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!
    await act(async () => {
      nativeValueSetter.call(time, '08:30')
      time.dispatchEvent(new Event('input', { bubbles: true }))
      time.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onChange).toHaveBeenCalledWith({ cron: '30 8 * * *', timezone: '' })
  })

  it('renders an error hint when one is provided', async () => {
    await mount(createElement(ScheduledTriggerPropertiesPanel, {
      cron: 'this is not cron',
      onChange: () => {},
      error: 'Expected exactly 5 fields, found 4: ...',
    }))
    const err = container.querySelector('[data-testid="drawer-field-error"]')
    expect(err?.textContent).toContain('Expected exactly 5 fields')
  })

  it('does not emit when switching INTO custom mode (preserves user expression)', async () => {
    const onChange = vi.fn()
    await mount(createElement(ScheduledTriggerPropertiesPanel, {
      cron: '0 11 * * *',
      onChange,
    }))
    const freq = container.querySelector('[data-testid="scheduled-trigger-frequency"]') as HTMLSelectElement
    await act(async () => {
      freq.value = 'custom'
      freq.dispatchEvent(new Event('change', { bubbles: true }))
    })
    // Switching INTO custom must not rewrite the cron string under the user.
    expect(onChange).not.toHaveBeenCalled()
  })

  it('renders a timezone input and shows the browser-detected fallback as a hint when empty', async () => {
    await mount(createElement(ScheduledTriggerPropertiesPanel, {
      cron: '0 9 * * *',
      onChange: () => {},
    }))
    const tz = container.querySelector('[data-testid="scheduled-trigger-timezone"]') as HTMLInputElement
    expect(tz).not.toBeNull()
    // Empty stored value → placeholder is the browser TZ (detectBrowserTimezone).
    expect(tz.value).toBe('')
    expect(tz.placeholder.length).toBeGreaterThan(0)
  })

  it('renders the stored timezone when present', async () => {
    await mount(createElement(ScheduledTriggerPropertiesPanel, {
      cron: '0 9 * * *',
      timezone: 'Asia/Shanghai',
      onChange: () => {},
    }))
    const tz = container.querySelector('[data-testid="scheduled-trigger-timezone"]') as HTMLInputElement
    expect(tz.value).toBe('Asia/Shanghai')
  })

  it('emits cron + new timezone when the user picks a TZ', async () => {
    const onChange = vi.fn()
    await mount(createElement(ScheduledTriggerPropertiesPanel, {
      cron: '0 9 * * *',
      timezone: 'UTC',
      onChange,
    }))
    const tz = container.querySelector('[data-testid="scheduled-trigger-timezone"]') as HTMLInputElement
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!
    await act(async () => {
      nativeSetter.call(tz, 'Asia/Shanghai')
      tz.dispatchEvent(new Event('input', { bubbles: true }))
      tz.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onChange).toHaveBeenCalledWith({ cron: '0 9 * * *', timezone: 'Asia/Shanghai' })
  })

  it('renders a timezone error when one is provided', async () => {
    await mount(createElement(ScheduledTriggerPropertiesPanel, {
      cron: '0 9 * * *',
      timezone: 'Mars/Olympus_Mons',
      onChange: () => {},
      timezoneError: 'Unknown timezone Mars/Olympus_Mons',
    }))
    // Two DrawerField errors max — find the timezone one.
    const errs = Array.from(container.querySelectorAll('[data-testid="drawer-field-error"]'))
    expect(errs.some((e) => e.textContent?.includes('Unknown timezone'))).toBe(true)
  })

  it('renders an idle next-run row when cron is empty', async () => {
    await mount(createElement(ScheduledTriggerPropertiesPanel, {
      cron: '',
      onChange: () => {},
    }))
    const row = container.querySelector('[data-testid="scheduled-trigger-next-run"]')
    expect(row).not.toBeNull()
    expect(row?.getAttribute('data-state')).toBe('idle')
    expect(row?.textContent).toMatch(/Edit a frequency/)
  })

  it('renders an idle next-run row when the panel already shows an error', async () => {
    // When the parent passes `error="bad cron"` we don't want to fan out a
    // server request that we already know will fail. The preview row
    // collapses to idle (the error itself is up next to the cron input).
    await mount(createElement(ScheduledTriggerPropertiesPanel, {
      cron: 'not a cron',
      onChange: () => {},
      error: 'invalid cron expression',
    }))
    const row = container.querySelector('[data-testid="scheduled-trigger-next-run"]')
    expect(row?.getAttribute('data-state')).toBe('idle')
  })
})
