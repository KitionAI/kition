import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { _electron as electron, expect, test } from '@playwright/test'
import electronPath from 'electron'

import { mockLocalWorkspaceApi } from './helpers/mockApi'
import { dismissFirstRunActivation } from './helpers/onboarding'

const FEISHU_IMAGE_HTML = '<meta charset="utf-8"><img src="https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/preview/image-id/?preview_type=16" alt="image-id">'
const TARGET_DOCUMENT_PATH = 'Articles/Nested/Paste target.md'

test('pastes a native image copied from a Feishu-style editor clipboard', async ({ baseURL }) => {
  test.setTimeout(60_000)
  expect(baseURL).toBeTruthy()

  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'kition-electron-image-paste-'))
  const shortcutModifier = process.platform === 'darwin' ? 'Meta' : 'Control'
  const app = await electron.launch({
    executablePath: electronPath,
    cwd: process.cwd(),
    args: ['.'],
    env: {
      ...process.env,
      HOME: tempHome,
      KITION_ELECTRON_DEV_SERVER_URL: baseURL as string,
      KITION_DESKTOP_SKIP_API: 'true',
      KITION_ELECTRON_TEST_DATA_DIR: tempHome,
    },
  })

  try {
    const page = await app.firstWindow()
    await mockLocalWorkspaceApi(page)
    await page.goto(new URL('/documents', baseURL as string).toString(), {
      waitUntil: 'commit',
    })
    await page.waitForLoadState('domcontentloaded')
    await dismissFirstRunActivation(page)

    const desktopInfo = await page.evaluate(() => window.kitionDesktop?.DesktopInfo?.())
    expect(desktopInfo?.workspace_dir).toBeTruthy()
    await page.evaluate(async () => {
      await window.kitionDesktop?.ImportWorkspaceFile?.({
        folder: 'Articles/Nested',
        filename: 'Paste target.md',
        base64_content: btoa('# Paste target\n\n'),
      })
      window.localStorage.setItem(
        'kition.document.last-active-path.v1',
        'Articles/Nested/Paste target.md',
      )
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('document-tree')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('workspace-document-inline-title')).toContainText('Paste target')

    await app.evaluate(({ clipboard, nativeImage }, payload) => {
      clipboard.write({
        html: payload.html,
        image: nativeImage.createFromPath(payload.pngPath),
      })
    }, {
      html: FEISHU_IMAGE_HTML,
      pngPath: path.join(process.cwd(), 'public', 'logo-mark.png'),
    })

    const bridgeKeys = await page.evaluate(() => Object.keys(window.kitionDesktop || {}))
    expect(bridgeKeys).toContain('ReadClipboardImage')
    const nativeClipboardImage = await page.evaluate(() => window.kitionDesktop!.ReadClipboardImage!())
    expect(nativeClipboardImage?.mime_type).toBe('image/png')
    expect(nativeClipboardImage?.base64_content.length).toBeGreaterThan(0)

    await page.evaluate(() => {
      const stateWindow = window as typeof window & {
        __kitionPastePayload?: {
          files: Array<{ name: string; type: string }>
          html: string
          items: Array<{ kind: string; type: string }>
          types: string[]
        }
      }
      window.addEventListener('paste', (event) => {
        stateWindow.__kitionPastePayload = {
          files: Array.from(event.clipboardData?.files || []).map((file) => ({
            name: file.name,
            type: file.type,
          })),
          html: event.clipboardData?.getData('text/html') || '',
          items: Array.from(event.clipboardData?.items || []).map((item) => ({
            kind: item.kind,
            type: item.type,
          })),
          types: Array.from(event.clipboardData?.types || []),
        }
      }, { capture: true, once: true })
    })

    const editorContent = page.locator('.document-editor .cm-content').first()
    await expect(editorContent).toBeVisible({ timeout: 30_000 })
    await editorContent.click()
    await editorContent.press(`${shortcutModifier}+V`)

    await expect.poll(() => page.evaluate(() => (
      (window as typeof window & { __kitionPastePayload?: unknown }).__kitionPastePayload
    ))).toBeTruthy()
    const pastePayload = await page.evaluate(() => (
      (window as typeof window & { __kitionPastePayload?: unknown }).__kitionPastePayload
    ))
    expect(pastePayload).toMatchObject({
      html: expect.stringContaining('internal-api-drive-stream.feishu.cn'),
    })
    await expect(page.locator('.cm-md-image img')).toBeVisible({ timeout: 15_000 })
    await expect.poll(async () => fs.readFile(
      path.join(desktopInfo!.workspace_dir!, TARGET_DOCUMENT_PATH),
      'utf8',
    )).toContain('![[Attachments/pasted-')
    await expect.poll(async () => fs.readdir(
      path.join(desktopInfo!.workspace_dir!, 'Attachments'),
    )).toEqual(expect.arrayContaining([
      expect.stringMatching(/^pasted-.*\.png$/),
    ]))
  } finally {
    await app.close()
    await fs.rm(tempHome, { recursive: true, force: true })
  }
})
