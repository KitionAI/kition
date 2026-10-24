import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { installDesktopHost } from './helpers/desktopHost'
import { mockLocalWorkspaceApi } from './helpers/mockApi'
import { dismissFirstRunActivation } from './helpers/onboarding'
import type { DesignDocument } from '../src/features/design/lib/designTypes'
/** Width and height from a PNG's IHDR chunk. */
function pngSize(bytes: Buffer) {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

test('edits and reopens a desktop Design with local assets, file moves, export, and image copy', async ({
  page,
  baseURL,
}, testInfo) => {
  test.setTimeout(120_000)
  const host = await installDesktopHost(page)
  const fixture = path.join(process.cwd(), 'public', 'logo-mark.png'),
    output = path.join(host.dataDir, 'poster.png')
  host.saveDialogPath = output
  try {
    await mockLocalWorkspaceApi(page)
    await page.route('**/workspace-files/**', (route) => route.abort())
    await page.goto(new URL('/documents', baseURL!).toString(), {
      waitUntil: 'domcontentloaded',
    })
    await dismissFirstRunActivation(page)
    await page
      .locator(
        '.document-private-heading .document-create-menu-anchor > button',
      )
      .click()
    await page.getByTestId('workspace-create-design-studio').click()
    await expect(page.getByTestId('design-editor')).toBeVisible()
    await page
      .getByLabel('Import image', { exact: true })
      .setInputFiles(fixture)
    await expect(page.locator('.design-artwork image')).toHaveCount(1)
    await expect(page.locator('.design-artwork image')).toHaveAttribute(
      'href',
      /^data:image/,
    )
    await page.getByRole('button', { name: 'Text', exact: true }).click()
    await page
      .getByRole('textbox', { name: 'Edit text', exact: true })
      .fill('Made in Kition')
    await page
      .getByRole('textbox', { name: 'Edit text', exact: true })
      .press('Meta+Enter')
    await expect(page.getByTestId('design-save-status')).toHaveText('Saved')
    const before = (await page.evaluate(async () =>
      JSON.parse(
        (
          await window.kitionDesktop!.ReadWorkspaceDocument!({
            path: 'Untitled design.kidesign',
          })
        ).content,
      ),
    )) as DesignDocument
    expect(
      Object.values(before.nodes)
        .map((n) => n.type)
        .sort(),
    ).toEqual(['image', 'text'])
    await page
      .locator('.document-tree-row', { hasText: 'Untitled design' })
      .first()
      .getByRole('button', { name: 'More actions', exact: true })
      .click()
    await page.getByRole('button', { name: 'Rename', exact: true }).click()
    await page.locator('.document-tree-rename-input').fill('Launch poster')
    await page.locator('.document-tree-rename-input').press('Enter')
    await expect(
      page.locator('.document-tab[data-tab-title="Launch poster"]'),
    ).toBeVisible()
    await page.locator('.document-tab[data-tab-title="Launch poster"]').click()
    await page.evaluate(async () => {
      await window.kitionDesktop!.CreateWorkspaceFolder!({ name: 'Posters' })
      window.dispatchEvent(
        new CustomEvent('kition:workspace-reload', {
          detail: { treeOnly: true },
        }),
      )
    })
    await expect(
      page.locator('.document-tree-row', { hasText: 'Posters' }).first(),
    ).toBeVisible()
    await page
      .locator('.document-tree-row', { hasText: 'Launch poster' })
      .first()
      .getByRole('button', { name: 'More actions', exact: true })
      .click()
    await page.getByRole('button', { name: 'Move to...', exact: true }).click()
    await page
      .locator('.document-tree-move-menu')
      .getByRole('button', { name: 'Posters', exact: true })
      .click()
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          try {
            return (
              await window.kitionDesktop!.ReadWorkspaceDocument!({
                path: 'Posters/Launch poster.kidesign',
              })
            ).path
          } catch {
            return ''
          }
        }),
      )
      .toBe('Posters/Launch poster.kidesign')
    await page.locator('.document-tab[data-tab-title="Launch poster"]').click()
    await expect(page.locator('.design-artwork image')).toHaveAttribute(
      'href',
      /^data:image/,
    )
    await page
      .locator('.document-tab[data-tab-title="Launch poster"]')
      .getByRole('button', { name: 'Close tab', exact: true })
      .click()
    await page
      .locator('.document-tree-row', { hasText: 'Launch poster' })
      .first()
      .click()
    await expect(page.getByTestId('design-editor')).toBeVisible()
    await expect(page.locator('.design-artwork text')).toContainText([
      'Made in Kition',
    ])
    const reopened = (await page.evaluate(async () =>
      JSON.parse(
        (
          await window.kitionDesktop!.ReadWorkspaceDocument!({
            path: 'Posters/Launch poster.kidesign',
          })
        ).content,
      ),
    )) as DesignDocument
    expect(reopened.nodes).toEqual(before.nodes)
    expect(reopened.assets).toEqual(before.assets)
    expect(reopened.id).toBe(before.id)
    await page.getByRole('button', { name: 'Close panel', exact: true }).click()
    await page.screenshot({ path: testInfo.outputPath('desktop-design.png') })
    await page.getByLabel('Export', { exact: true }).click()
    await page
      .getByRole('button', { name: 'Download PNG', exact: true })
      .click()
    await expect
      .poll(async () =>
        fs
          .stat(output)
          .then((s) => s.size)
          .catch(() => 0),
      )
      .toBeGreaterThan(100)
    await page.getByLabel('Export', { exact: true }).click()
    await page.getByRole('button', { name: 'Copy image', exact: true }).click()
    await expect(
      page.getByText('Design copied as an image', { exact: true }),
    ).toBeVisible()
    expect(host.clipboard.imageSource).toMatch(/^data:image\/png;base64,/)
    const copied = Buffer.from(host.clipboard.imageSource.split(',')[1], 'base64')
    expect(pngSize(copied)).toEqual({ width: 1080, height: 1440 })
    expect(pngSize(await fs.readFile(output))).toEqual({ width: 1080, height: 1440 })
    const source = Object.values(before.assets)[0]
    await page.evaluate(
      (imagePath) =>
        window.dispatchEvent(
          new CustomEvent('kition:search:open-path', {
            detail: { path: imagePath },
          }),
        ),
      source.path,
    )
    await page
      .getByRole('button', { name: 'Create design from image', exact: true })
      .click()
    await expect(
      page.locator('.design-editor:visible .design-artwork image'),
    ).toHaveAttribute('href', /^data:image/)
    const sourceTitle = source.path
      .split('/')
      .pop()!
      .replace(/\.[^.]+$/, '')
    const created = (await page.evaluate(
      async (filePath) =>
        JSON.parse(
          (
            await window.kitionDesktop!.ReadWorkspaceDocument!({
              path: filePath,
            })
          ).content,
        ),
      `${sourceTitle}.kidesign`,
    )) as DesignDocument
    expect(created.provenance?.imagePath).toBe(source.path)
    expect(created.pages[0]).toMatchObject({
      width: source.width,
      height: source.height,
    })
    expect(Object.values(created.nodes)).toHaveLength(1)
  } finally {
    await host.dispose()
  }
})
