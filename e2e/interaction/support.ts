/**
 * Shared conventions of the kit interaction suite (e2e/interaction/). The suite is expensive and
 * runs only through `pnpm test:interaction:e2e`, when the owner asks for it; the CI sweep ignores
 * this folder (tooling/playwright.config.ts).
 *
 * Each spec is `<kit>.spec.ts` and tags every test with its kit, its host-matrix row and, for a
 * data-loss or core-editing check, `@p0`, so one kit or one row runs alone:
 * `pnpm test:interaction:e2e --grep @sheet`, `--grep @H5`, `--grep @p0`.
 */
import { expect, type Page } from '@playwright/test'

/** The host-matrix rows every kit goes through (the interaction test plan). */
export type HostRow = 'H1' | 'H2' | 'H3' | 'H4' | 'H5' | 'H6' | 'H7' | 'H8' | 'H9' | 'H10' | 'H11' | 'H12' | 'H13' | 'H14' | 'H15'

/** The tags of a test: its kit, its host-matrix rows, and `@p0` when a failure loses data or blocks editing. */
export function tags(kit: string, rows: HostRow[], p0 = false) {
  return { tag: [`@${kit}`, ...rows.map((row) => `@${row}`), ...(p0 ? ['@p0'] : [])] }
}

/**
 * Collects the page's uncaught errors and console errors, in the page and in kit frames, so a test
 * can end with `await errors.expectNone()`. `ignore` drops known, harmless messages.
 */
export function collectErrors(page: Page, ignore: RegExp[] = []) {
  const messages: string[] = []
  const keep = (text: string) => {
    if (!ignore.some((pattern) => pattern.test(text))) messages.push(text)
  }
  page.on('pageerror', (error) => keep(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') keep(`console: ${message.text()}`)
  })
  return {
    messages,
    expectNone: async () => expect(messages, 'page and kit frame errors').toEqual([]),
  }
}
