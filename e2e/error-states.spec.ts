import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'

import { openKitWorkspace, openTreeFile } from './helpers/embeddedKit'
import { mockKitTables } from './helpers/kitTables'
import { caretAfter, openNote } from './helpers/noteKit'

/**
 * Plan item A6: every empty and error state says what happened in plain words and offers a next
 * step (retry, configure, start something), never a raw error, and the window stays usable.
 */

test.describe.configure({ timeout: 120_000 })

const RUNTIME = (url: URL) => url.port === '18101'
/** What a raw error looks like on screen: a stack, an error class, JSON, an untranslated key, a system error. */
const RAW = /\bError:|TypeError|\bat \w+ \(|\{\{|\}\}|"code"|os error \d+|Failed to fetch|\.wasm|EOCD|not a database/

async function expectPlain(target: Locator) {
  const text = await target.innerText()
  expect(text, `raw error on screen:\n${text}`).not.toMatch(RAW)
}

const kitFrame = (page: Page) => page.frameLocator('[data-testid="kit-frame"][data-active="true"] [data-testid="kit-frame-window"]')

test('an empty workspace invites a first document, and a failed Getting Started setup offers Retry', async ({ page, baseURL }) => {
  const { host } = await openKitWorkspace(page, baseURL!, {}, {
    routes: async (p) => {
      await mockKitTables(p, [])
      await p.route('**/onboarding/manifest.json', (route) => route.fulfill({ status: 500, body: 'unavailable' }))
    },
  })
  try {
    await expect(page.getByText('Turn ideas into organized work')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('button', { name: /New document/ })).toBeEnabled()
    const notice = page.getByRole('alert').filter({ hasText: 'Getting Started' })
    await expect(notice).toContainText("Couldn't set up your Getting Started files")
    await expect(notice.getByRole('button', { name: 'Retry' })).toBeVisible()
    await expectPlain(page.locator('body'))
    await page.getByRole('button', { name: /New document/ }).click()
    // The window stays usable: New document offers a blank document or a template.
    await expect(page.getByText('Choose a template or a blank document to create a new Markdown document.')).toBeVisible({ timeout: 15_000 })
  } finally {
    await host.dispose()
  }
})

test("a file opened while Kition's file service is unreachable is not called damaged, and opens once it answers", async ({ page, baseURL }) => {
  const { host } = await openKitWorkspace(page, baseURL!, { 'Note.md': Buffer.from('# Note\n\nKept.\n') }, { routes: async (p) => { await mockKitTables(p, []) } })
  try {
    await page.route(RUNTIME, (route) => route.abort('connectionrefused'))
    await page.locator('.document-tree-row', { hasText: 'Note' }).first().click()
    const notice = page.getByTestId('kit-open-failed')
    await expect(notice).toBeVisible({ timeout: 30_000 })
    await expect(notice).toContainText("Kition can't reach its file service right now. The file has not been changed.")
    await expect(notice).not.toContainText('may be damaged')
    await expectPlain(notice)
    await page.unroute(RUNTIME)
    await notice.getByTestId('kit-open-retry').click()
    await expect(kitFrame(page).getByTestId('note-editor')).toBeVisible({ timeout: 60_000 })
  } finally {
    await host.dispose()
  }
})

test("an editor whose engine can't load says so, keeps the file, and opens on Try again", async ({ page, baseURL }) => {
  const engine = /\/kits\/note-ui\/engine\/.*\.wasm/
  const { host } = await openKitWorkspace(page, baseURL!, { 'Note.md': Buffer.from('# Note\n') }, {
    routes: async (p) => {
      await mockKitTables(p, [])
      await p.route(engine, (route) => route.fulfill({ status: 500, body: '' }))
    },
  })
  try {
    await page.locator('.document-tree-row', { hasText: 'Note' }).first().click()
    const notice = page.getByTestId('kit-open-failed')
    await expect(notice).toBeVisible({ timeout: 30_000 })
    await expect(notice).toContainText("couldn't start. The file has not been changed.")
    await expect(notice).not.toContainText('may be damaged')
    await expectPlain(notice)
    await page.unroute(engine)
    await notice.getByTestId('kit-open-retry').click()
    await expect(kitFrame(page).getByTestId('note-editor')).toBeVisible({ timeout: 60_000 })
  } finally {
    await host.dispose()
  }
})

test('a damaged file says so in plain words and keeps the reader error under Technical details', async ({ page, baseURL }) => {
  const { host } = await openKitWorkspace(page, baseURL!, { 'Broken.docx': Buffer.from('PK\u0003\u0004 not a real document'), 'Fine.md': Buffer.from('# Fine\n') }, {
    routes: async (p) => { await mockKitTables(p, []) },
  })
  try {
    await page.locator('.document-tree-row', { hasText: 'Broken' }).first().click()
    const notice = page.getByTestId('kit-open-failed')
    await expect(notice).toBeVisible({ timeout: 60_000 })
    await expect(notice).toContainText('Could not open Broken.docx')
    await expect(notice).toContainText('The file may be damaged or not a valid DOCX file. It has not been changed.')
    await expect(notice.getByTestId('kit-open-retry')).toBeVisible()
    await expectPlain(notice)
    // The reason is one click away.
    await notice.getByText('Technical details').click()
    await expect(notice.getByTestId('file-notice-detail')).toBeVisible()
    // The window stays usable: another file opens.
    await openTreeFile(page, 'Fine.md')
    await expect(kitFrame(page).getByTestId('note-editor')).toBeVisible({ timeout: 60_000 })
  } finally {
    await host.dispose()
  }
})

test('a save the disk refuses says why in plain words, keeps the edit, and saves once there is room', async ({ page, baseURL }) => {
  let full = true
  const { host, kit } = await openNote(page, baseURL!, 'Note.md', '# Note\n\nHello.\n', {}, { persist: true, routes: async (p) => { await mockKitTables(p, []) } })
  try {
    await page.route('**/api/v1/kits/files?**', (route) => (full
      ? route.fulfill({ status: 507, contentType: 'application/json', body: JSON.stringify({ code: 507, message: 'No space left on device (os error 28)' }) })
      : route.fallback()))
    await caretAfter(page, kit, 'Hello.')
    await page.keyboard.type(' More.')
    await kit.getByTestId('note-save').click()
    await expect(kit.getByText('There is no space left on this disk. Free up some space, then save again.')).toBeVisible({ timeout: 30_000 })
    await expect(kit.getByTestId('note-unsaved')).toBeVisible()
    await expectPlain(kit.locator('body'))
    full = false
    await kit.getByTestId('note-save').click()
    await expect(kit.getByTestId('note-unsaved')).toHaveCount(0, { timeout: 30_000 })
    await expect.poll(async () => fs.readFile(path.join(host.root, 'Note.md'), 'utf8')).toContain('Hello. More.')
  } finally {
    await host.dispose()
  }
})

test('the agent without a model says so and offers Configure', async ({ page, baseURL }) => {
  const { host } = await openKitWorkspace(page, baseURL!, { 'Note.md': Buffer.from('# Note\n') }, { routes: async (p) => { await mockKitTables(p, []) } })
  try {
    await page.getByRole('button', { name: 'Open AI Chat' }).click()
    await expect(page.getByText('No model configured')).toBeVisible({ timeout: 30_000 })
    const configure = page.getByRole('button', { name: 'Configure', exact: true })
    await expect(configure).toBeVisible()
    await expectPlain(page.locator('body'))
    await configure.click()
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible({ timeout: 15_000 })
  } finally {
    await host.dispose()
  }
})
