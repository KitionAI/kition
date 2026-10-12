import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, type Page, type Route } from '@playwright/test'
import { installDesktopHost } from './desktopHost'
import { fulfillJson, mockLocalWorkspaceApi } from './mockApi'
import { dismissFirstRunActivation } from './onboarding'

/** A kit's engine built into `public/kits/<kit>-sdk`, loaded in Node to make and read fixtures. */
export function kitEngine<T>(kit: string, module: string) {
  const dir = path.join(process.cwd(), 'public', 'kits', `${kit}-sdk`)
  const wasm = path.join(dir, `${module}_bg.wasm`)
  return {
    built: existsSync(wasm) && existsSync(path.join(process.cwd(), 'public', 'kits', `${kit}-ui`, 'kit-ui.json')),
    load: async () => {
      const sdk = (await import(pathToFileURL(path.join(dir, `${module}.js`)).href)) as { default: (input: { module_or_path: Buffer }) => Promise<unknown> } & T
      await sdk.default({ module_or_path: await fs.readFile(wasm) })
      return sdk
    },
  }
}

/** Serves the workspace's files as the runtime's file server does (ETag, Last-Modified). */
async function serveWorkspace(page: Page, root: string) {
  await page.route('**/workspace-files/**', async (route: Route) => {
    const relative = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^.*\/workspace-files\//, ''))
    const file = path.join(root, relative)
    if (!file.startsWith(root) || !existsSync(file)) return route.fulfill({ status: 404, body: '' })
    const stat = await fs.stat(file)
    const headers = { etag: `"${stat.mtimeMs}-${stat.size}"`, 'last-modified': stat.mtime.toUTCString(), 'access-control-expose-headers': 'ETag,Content-Range,Accept-Ranges', 'content-type': 'application/octet-stream' }
    if (route.request().method() === 'HEAD') return route.fulfill({ status: 200, headers, body: '' })
    return route.fulfill({ status: 200, headers, body: await fs.readFile(file) })
  })
}

/**
 * Opens `name` (written to the workspace from `bytes`) in Kition, where the kit's own editor
 * shows in a frame; answers the frame, and the files Kition saved through its file API.
 */
export async function openInKitFrame(page: Page, baseURL: string, name: string, bytes: Buffer, others: Record<string, Buffer> = {}) {
  const host = await installDesktopHost(page)
  // Files the document links (media), workspace-relative.
  for (const [other, content] of Object.entries(others)) {
    await fs.mkdir(path.dirname(path.join(host.root, other)), { recursive: true })
    await fs.writeFile(path.join(host.root, other), content)
  }
  await fs.mkdir(path.dirname(path.join(host.root, name)), { recursive: true })
  await fs.writeFile(path.join(host.root, name), bytes)
  await mockLocalWorkspaceApi(page)
  await serveWorkspace(page, host.root)
  const saves: Array<{ path: string | null; bytes: Buffer }> = []
  await page.route('**/api/v1/kits/files?**', async (route) => {
    const target = new URL(route.request().url()).searchParams.get('path')
    const body = route.request().postDataBuffer() ?? Buffer.alloc(0)
    saves.push({ path: target, bytes: body })
    await fulfillJson(route, { code: 200, message: 'success', data: { path: target, bytes: body.length } })
  })
  await page.goto(new URL('/documents', baseURL).toString(), { waitUntil: 'domcontentloaded' })
  await dismissFirstRunActivation(page)
  // A document in a folder: open the folder in the tree first.
  for (const folder of name.split('/').slice(0, -1)) await page.locator('.document-tree-row', { hasText: folder }).first().click()
  await page.locator('.document-tree-row', { hasText: (name.split('/').pop() ?? name).replace(/\.[^.]+$/, '') }).first().click()
  await expect(page.getByTestId('kit-frame')).toBeVisible()
  return { host, saves, kit: page.frameLocator('[data-testid="kit-frame-window"]') }
}
