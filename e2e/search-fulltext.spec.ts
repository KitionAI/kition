import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { openKitWorkspace, openTreeFile, serveWorkspace } from './helpers/embeddedKit'
import { mockKitTables } from './helpers/kitTables'

test.describe.configure({ timeout: 60_000 })

async function openSearch(page: Page) {
  await page.getByTestId('sidebar-tab-search').click()
  const input = page.getByTestId('search-palette-input')
  await expect(input).toBeEnabled({ timeout: 15_000 })
  return input
}

test('the search Worker indexes notes and table records, filters them, and opens a note', async ({ page, baseURL }) => {
  const { host } = await openKitWorkspace(page, baseURL!, {
    'notes/Alpha.md': Buffer.from('# Alpha\n\nA nebula observation.\n\n- [ ] nebula launch\n\n- [x] comet review\n'),
    'notes/Beta.md': Buffer.from('# Beta\n\nA comet observation.\n'),
  }, {
    routes: async page => {
      await mockKitTables(page, [{ path: 'Tasks.ktable', tables: [{
        id: 'tasks', title: 'Tasks',
        fields: [{ id: 'notes', name: 'notes', title: 'Notes', type: 'text' }],
        records: [{ id: 'launch', values: { notes: 'nebula cargo' } }],
      }] }])
    },
  })
  try {
    await openTreeFile(page, 'notes/Beta.md')
    const input = await openSearch(page)
    const results = page.getByTestId('search-result-item')
    await input.fill('nebula')
    await expect(results.filter({ hasText: 'nebula cargo' })).toBeVisible()
    await expect(results).toHaveCount(3)
    await input.fill('file:Alpha nebula')
    await expect(results.locator('.search-result-title')).toHaveText(['Alpha', 'Alpha'])
    await input.fill('task-todo: nebula')
    await expect(results).toHaveCount(1)
    await expect(results).toContainText('nebula launch')
    await input.fill('table:Tasks field:Notes nebula')
    await expect(results).toHaveCount(1)
    await expect(results).toContainText('Notes: nebula cargo')
    await input.fill('file:Alpha nebula')
    await expect(results).toHaveCount(2)
    await results.filter({ hasText: 'nebula launch' }).click()
    await expect(page.getByTestId('search-palette')).toHaveCount(0)
    await expect(page.locator('.document-tab.is-active')).toContainText('Alpha')
  } finally {
    await host.dispose()
  }
})

test('a workspace reload indexes a newly added note without waiting for the listing TTL', async ({ page, baseURL }) => {
  const { host } = await openKitWorkspace(page, baseURL!, {
    'Original.md': Buffer.from('# Original\n\nAn existing document.\n'),
  }, { routes: async page => { await mockKitTables(page, []) } })
  try {
    const input = await openSearch(page)
    await input.fill('freshatlas')
    await expect(page.getByTestId('search-palette-empty')).toBeVisible()
    await fs.writeFile(path.join(host.root, 'Fresh.md'), '# Fresh\n\nfreshatlas is now searchable.\n')
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('kition:workspace-reload', { detail: { treeOnly: true } })))
    await expect(page.getByTestId('search-result-item')).toHaveCount(1)
    await expect(page.getByTestId('search-result-item')).toContainText('freshatlas is now searchable')
  } finally {
    await host.dispose()
  }
})

test('switching workspaces indexes the new notes and removes the old workspace results', async ({ page, baseURL }) => {
  const { host } = await openKitWorkspace(page, baseURL!, {
    'Private.md': Buffer.from('# Private\n\nprivateatlas belongs to the first workspace.\n'),
  }, { routes: async page => { await mockKitTables(page, []) } })
  try {
    const input = await openSearch(page)
    await input.fill('privateatlas')
    await expect(page.getByTestId('search-result-item')).toContainText('privateatlas')
    await input.press('Escape')
    const second = path.join(host.dataDir, 'second-workspace')
    await fs.mkdir(second)
    await fs.writeFile(path.join(second, 'Public.md'), '# Public\n\npublicatlas belongs to the second workspace.\n')
    await page.evaluate(async root => {
      await window.kitionDesktop!.AddVault!({ path: root, name: 'Second workspace' })
    }, second)
    await serveWorkspace(page, second)
    await page.getByTestId('workspace-launcher-nav-button').click()
    await page.getByTestId('workspace-launcher').getByRole('button', { name: /Second workspace/ }).click()
    await page.getByRole('button', { name: 'Open here', exact: true }).click()
    await expect(page.getByTestId('workspace-launcher')).toHaveCount(0)
    const nextInput = await openSearch(page)
    await nextInput.fill('publicatlas')
    await expect(page.getByTestId('search-result-item')).toHaveCount(1)
    await expect(page.getByTestId('search-result-item')).toContainText('publicatlas')
    await nextInput.fill('privateatlas')
    await expect(page.getByTestId('search-palette-empty')).toBeVisible()
    await expect(page.getByTestId('search-result-item')).toHaveCount(0)
  } finally {
    await host.dispose()
  }
})
