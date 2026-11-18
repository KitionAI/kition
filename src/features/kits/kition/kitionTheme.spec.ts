import { afterEach, describe, expect, it, vi } from 'vitest'

import type { KitTheme } from '../host/mountKit'
import { kitionTheme, watchKitionTheme } from './kitionTheme'

/** What src/app/styles.css computes on the root for each scheme (a few of the tokens). */
const SCHEMES = {
  light: { '--kit-surface': '#ffffff', '--kit-text': '#1a1a1a', '--kit-primary': '#5645d4' },
  dark: { '--kit-surface': '#1f2329', '--kit-text': '#eceff1', '--kit-primary': '#5645d4' },
} as const

/** Shows `scheme` as Kition does (`.dark` on the root) with the tokens its stylesheet gives it. */
function show(scheme: keyof typeof SCHEMES) {
  const root = document.documentElement
  root.classList.toggle('dark', scheme === 'dark')
  for (const [name, value] of Object.entries(SCHEMES[scheme])) root.style.setProperty(name, value)
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  const root = document.documentElement
  root.classList.remove('dark')
  for (const name of Object.keys(SCHEMES.light)) root.style.removeProperty(name)
})

describe('kitionTheme', () => {
  it('is the scheme Kition shows, with the tokens its stylesheet gives that scheme', () => {
    show('light')
    expect(kitionTheme()).toMatchObject({ colorScheme: 'light', tokens: SCHEMES.light })
    show('dark')
    expect(kitionTheme()).toMatchObject({ colorScheme: 'dark', tokens: SCHEMES.dark })
  })

  it('sends only tokens the stylesheet sets', () => {
    show('light')
    expect(Object.values(kitionTheme().tokens).every((value) => value !== '')).toBe(true)
  })
})

describe('watchKitionTheme', () => {
  it('tells of each change of scheme once (UI-H6), and nothing once stopped', async () => {
    show('light')
    const changed = vi.fn<(theme: KitTheme) => void>()
    const stop = watchKitionTheme(kitionTheme(), changed)

    show('dark')
    await flush()
    expect(changed).toHaveBeenCalledTimes(1)
    expect(changed.mock.calls[0][0]).toMatchObject({ colorScheme: 'dark', tokens: SCHEMES.dark })

    // A class that changes nothing the kit sees (the theme transition) sends nothing.
    document.documentElement.classList.add('theme-transitioning')
    await flush()
    document.documentElement.classList.remove('theme-transitioning')
    await flush()
    expect(changed).toHaveBeenCalledTimes(1)

    stop()
    show('light')
    await flush()
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('sends the theme at once when it changed between the open and the watch', async () => {
    show('light')
    const sent = kitionTheme()
    show('dark')
    const changed = vi.fn<(theme: KitTheme) => void>()
    const stop = watchKitionTheme(sent, changed)
    expect(changed).toHaveBeenCalledTimes(1)
    expect(changed.mock.calls[0][0].colorScheme).toBe('dark')
    stop()
  })
})
