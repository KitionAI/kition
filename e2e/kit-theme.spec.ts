import { expect, test, type Frame, type Page } from '@playwright/test'
import { noteFrame, openNote } from './helpers/noteKit'

/**
 * A kit follows Kition's theme (Kit UI protocol section 4, UI-H6): it opens in the scheme Kition
 * shows, with the tokens Kition's stylesheet gives that scheme, and a later switch between light and
 * dark reaches the open kit (`ui/theme`). The Note kit stands for every kit: kit-editor applies the
 * theme the same way in each.
 */
test.setTimeout(120_000)

/** Kition's scheme and surface token, as its root shows them. */
const host = (page: Page) =>
  page.evaluate(() => ({
    scheme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
    surface: getComputedStyle(document.documentElement).getPropertyValue('--kit-surface').trim(),
  }))

/** The scheme and surface token the kit's page applied to its root. */
const kitTheme = (frame: Frame) =>
  frame.evaluate(() => ({
    scheme: document.documentElement.dataset.colorScheme,
    surface: getComputedStyle(document.documentElement).getPropertyValue('--kit-surface').trim(),
  }))

/** Switches Kition's scheme as Display settings do: the root's class, which its stylesheet's tokens follow. */
const showScheme = (page: Page, scheme: 'light' | 'dark') =>
  page.evaluate((dark) => {
    const root = document.documentElement
    root.classList.toggle('dark', dark)
    root.dataset.desktopTheme = dark ? 'dark' : 'light'
    root.style.colorScheme = dark ? 'dark' : 'light'
  }, scheme === 'dark')

test('an open kit takes Kition’s scheme and its tokens, and follows each switch between light and dark', async ({ page, baseURL }) => {
  await openNote(page, baseURL!, 'Plan.md', '# Plan\n\nGoals.\n')
  const frame = await noteFrame(page)

  const light = await host(page)
  expect(light.scheme).toBe('light')
  await expect.poll(() => kitTheme(frame)).toEqual(light)

  await showScheme(page, 'dark')
  const dark = await host(page)
  expect(dark.scheme).toBe('dark')
  expect(dark.surface).not.toBe(light.surface)
  await expect.poll(() => kitTheme(frame)).toEqual(dark)

  await showScheme(page, 'light')
  await expect.poll(() => kitTheme(frame)).toEqual(light)
})
