import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import electronPath from 'electron'
import { mockLocalWorkspaceApi } from './helpers/mockApi'
import { dismissFirstRunActivation } from './helpers/onboarding'
import type { DesignDocument } from '../src/features/design/lib/designTypes'
test('edits and reopens a desktop Design with local assets, file moves, export, and native image copy', async ({
  baseURL,
}, testInfo) => {
  test.setTimeout(120_000)
  const profile = await fs.mkdtemp(
    path.join(os.tmpdir(), 'kition-desktop-design-'),
  )
  const fixture = path.join(process.cwd(), 'public', 'logo-mark.png'),
    output = path.join(profile, 'poster.png')
  const app = await electron.launch({
    executablePath: electronPath,
    cwd: process.cwd(),
    args: ['.'],
    env: {
      ...process.env,
      KITION_ELECTRON_DEV_SERVER_URL: baseURL!,
      KITION_DESKTOP_SKIP_API: 'true',
      KITION_ELECTRON_TEST_DATA_DIR: profile,
    },
  })
  try {
    await app.evaluate(({ clipboard, dialog }, outputPath) => {
      const state = globalThis as any
      state.__designClipboard = {
        text: clipboard.readText(),
        html: clipboard.readHTML(),
        rtf: clipboard.readRTF(),
        image: clipboard.readImage(),
      }
      state.__designSaveDialog = dialog.showSaveDialog
      dialog.showSaveDialog = async () => ({
        canceled: false,
        filePath: outputPath,
      })
    }, output)
    const page = await app.firstWindow()
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
    await page.getByTestId('workspace-create-design').click()
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
    const pixels = await app.evaluate(
      ({ clipboard, nativeImage }, filename) => {
        const actual = clipboard.readImage(),
          expected = nativeImage.createFromPath(filename)
        return {
          size: actual.getSize(),
          equal: actual.toBitmap().equals(expected.toBitmap()),
        }
      },
      output,
    )
    expect(pixels).toEqual({ size: { width: 1080, height: 1440 }, equal: true })
    await page.evaluate(() => {
      const target = document.createElement('textarea')
      target.setAttribute('aria-label', 'Image paste target')
      target.style.cssText = 'position:fixed;top:8px;left:8px;z-index:100'
      target.addEventListener('paste', (event) => {
        event.preventDefault()
        target.value = Array.from(event.clipboardData?.files || [])
          .map((file) => file.type)
          .join(',')
      })
      document.body.appendChild(target)
    })
    await page.getByLabel('Image paste target').focus()
    await page.getByLabel('Image paste target').press('Meta+V')
    await expect(page.getByLabel('Image paste target')).toHaveValue('image/png')
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
    await app
      .evaluate(({ clipboard, dialog }) => {
        const state = globalThis as any
        if (state.__designClipboard) clipboard.write(state.__designClipboard)
        if (state.__designSaveDialog)
          dialog.showSaveDialog = state.__designSaveDialog
      })
      .catch(() => {})
    await app.close()
    await fs.rm(profile, { recursive: true, force: true })
  }
})
