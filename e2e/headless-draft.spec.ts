import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { installDesktopHost } from './helpers/desktopHost'
import { fulfillJson, mockLocalWorkspaceApi } from './helpers/mockApi'
import { dismissFirstRunActivation } from './helpers/onboarding'

const FILE = 'Budget.xlsx'

/** A draft an agent kept beside the file over `kition-kits-mcp --drafts`, as the runtime lists it. */
function draft(stale: boolean) {
  return { version: 1, path: FILE, kit: 'kit.sheet', mode: 'replica', state: 'ready', baseSha256: 'a'.repeat(64), created: 1, updated: 1, stale }
}

const comparison = {
  path: FILE,
  kit: 'kit.sheet',
  mode: 'replica',
  state: 'ready',
  stale: true,
  diff: {
    created: [{ id: 'c1', type: 'Cell', fields: ['value'] }],
    changed: [{ id: 'sheet1', type: 'Sheet', fields: ['cells'] }],
    deleted: [],
    texts: [{ id: 'c1', field: 'value', before: '', after: 'Q3 forecast' }],
  },
  summary: { base: 'Budget: 1 sheet, A1:B2', draft: 'Budget: 1 sheet, A1:B3' },
}

test('a headless agent draft is marked in the tree, reviewed, and merged by the person after confirming', async ({ page, baseURL }) => {
  const host = await installDesktopHost(page)
  try {
    await fs.writeFile(path.join(host.root, FILE), Buffer.from('PK'))
    await mockLocalWorkspaceApi(page)
    let drafts = [draft(true)]
    const merges: Array<{ path: string; overwrite: boolean }> = []
    await page.route('**/api/v1/kits/drafts**', async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname.endsWith('/kits/drafts')) return fulfillJson(route, { code: 200, message: 'success', data: { drafts } })
      if (url.pathname.endsWith('/kits/drafts/compare')) return fulfillJson(route, { code: 200, message: 'success', data: comparison })
      if (url.pathname.endsWith('/kits/drafts/merge')) {
        const body = route.request().postDataJSON() as { path: string; overwrite?: boolean }
        merges.push({ path: body.path, overwrite: Boolean(body.overwrite) })
        if (!body.overwrite) return fulfillJson(route, { code: 40905, message: 'changed since the draft forked', data: { reason: 'stale' } }, 409)
        drafts = []
        return fulfillJson(route, { code: 200, message: 'success', data: { path: FILE, merged: true, sha256: 'b'.repeat(64) } })
      }
      return route.fallback()
    })

    await page.goto(new URL('/documents', baseURL!).toString(), { waitUntil: 'domcontentloaded' })
    await dismissFirstRunActivation(page)
    const row = page.locator('.document-tree-row', { hasText: 'Budget' }).first()
    const badge = row.getByTestId('headless-draft-badge')
    await expect(badge).toBeVisible({ timeout: 30_000 })
    await expect(badge).toHaveAttribute('data-state', 'ready')

    await badge.click()
    const review = page.getByTestId('headless-draft-review')
    await expect(review).toBeVisible()
    await expect(page.getByTestId('headless-draft-summary')).toContainText('1 object added')
    await expect(page.getByTestId('headless-draft-after')).toContainText('A1:B3')
    await expect(review).toContainText('Q3 forecast')
    await expect(page.getByTestId('headless-draft-stale')).toBeVisible()
    // The sheet has slid in fully (its 200 ms transition), fits the window, and the floating agent
    // launcher steps aside so it covers neither the footer nor Merge and Discard.
    const sheet = page.getByTestId('right-sheet')
    await expect.poll(async () => sheet.evaluate((element) => getComputedStyle(element).transform)).toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/)
    const box = await sheet.boundingBox()
    const viewport = page.viewportSize()!
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width)
    expect(box!.x).toBeGreaterThanOrEqual(0)
    await expect(page.getByTestId('headless-draft-merge')).toBeInViewport({ ratio: 1 })
    await expect(page.getByTestId('headless-draft-discard')).toBeInViewport({ ratio: 1 })
    await expect(page.getByTestId('agent-floating-launcher')).toBeHidden()
    await page.screenshot({ path: path.join(os.homedir(), '.cache', 'hd', 'headless-draft-review.png') })

    // The file changed since the draft forked: the runtime refuses, and the person confirms.
    await page.getByTestId('headless-draft-merge').click()
    await expect(page.getByTestId('headless-draft-overwrite')).toBeVisible()
    expect(merges).toEqual([{ path: FILE, overwrite: false }])
    await page.getByTestId('headless-draft-overwrite').click()
    await expect(review).toHaveCount(0)
    expect(merges).toEqual([
      { path: FILE, overwrite: false },
      { path: FILE, overwrite: true },
    ])
    await expect(row.getByTestId('headless-draft-badge')).toHaveCount(0)
  } finally {
    await host.dispose()
  }
})
