import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const indexHtml = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8')
const bootstrapScript = indexHtml.match(/<script data-theme-bootstrap>([\s\S]*?)<\/script>/)?.[1]

function runThemeBootstrap() {
  expect(bootstrapScript).toBeTruthy()
  Function(bootstrapScript!)()
}

describe('theme bootstrap', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.className = ''
    document.documentElement.removeAttribute('data-desktop-theme')
    document.documentElement.removeAttribute('data-desktop-theme-mode')
    document.documentElement.style.colorScheme = ''
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
      matches: query === '(prefers-color-scheme: dark)',
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses dark on the first frame for a new user', () => {
    runThemeBootstrap()

    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.dataset.desktopThemeMode).toBe('dark')
    expect(document.documentElement.dataset.desktopTheme).toBe('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')
  })

  it('uses the saved bootstrap theme before the app loads', () => {
    localStorage.setItem('kition.desktop.theme.bootstrap.v1', 'light')

    runThemeBootstrap()

    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(document.documentElement.dataset.desktopThemeMode).toBe('light')
    expect(document.documentElement.dataset.desktopTheme).toBe('light')
  })

  it('falls back to the existing settings backup during rollout', () => {
    localStorage.setItem('kition.desktop.settings.backup.v1', JSON.stringify({
      general: { theme: 'auto' },
    }))

    runThemeBootstrap()

    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.dataset.desktopThemeMode).toBe('auto')
    expect(document.documentElement.dataset.desktopTheme).toBe('dark')
  })
})
