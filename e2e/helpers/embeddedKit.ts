import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, type Page, type Route } from '@playwright/test'
import { installDesktopHost, type DesktopHostOptions } from './desktopHost'
import { versionCounters } from './kitionPro'
import { serveKitGrants } from './kitGrants'
import { fulfillJson, mockLocalWorkspaceApi } from './mockApi'
import { dismissFirstRunActivation } from './onboarding'

/** A kit's engine in its package, `public/kits/<kit>-ui/engine`, loaded in Node to make and read fixtures. */
export function kitEngine<T>(kit: string, module: string) {
  const dir = path.join(process.cwd(), 'public', 'kits', `${kit}-ui`, 'engine')
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

/**
 * Serves the workspace's files as the runtime's file services do (ETag, Last-Modified):
 * `/workspace-files/` for Kition, and `/kit-files/` for kits, which never serves a hidden path
 * (`.kition/`, rule LR2).
 */
export async function serveWorkspace(page: Page, root: string) {
  await page.route(/\/(workspace|kit)-files\//, async (route: Route) => {
    const url = new URL(route.request().url())
    const [, service, relative] = /\/(workspace|kit)-files\/(.*)$/.exec(url.pathname) ?? []
    const decoded = decodeURIComponent(relative ?? '')
    const file = path.join(root, decoded)
    const hidden = service === 'kit' && decoded.split('/').some((part) => part.startsWith('.'))
    if (hidden || !file.startsWith(root) || !existsSync(file)) return route.fulfill({ status: 404, body: '' })
    const stat = await fs.stat(file)
    const headers = { etag: `"${stat.mtimeMs}-${stat.size}"`, 'last-modified': stat.mtime.toUTCString(), 'access-control-expose-headers': 'ETag,Content-Range,Accept-Ranges', 'content-type': 'application/octet-stream' }
    if (route.request().method() === 'HEAD') return route.fulfill({ status: 200, headers, body: '' })
    return route.fulfill({ status: 200, headers, body: await fs.readFile(file) })
  })
}

/** A kit editor's display mode, by kit id: kit-ui keeps the person's choice in the page's storage. */
export type KitModes = Record<string, 'menus' | 'line' | 'classic'>

/**
 * Pins kit editors' display modes before the page loads, for specs that click the Classic ribbon or
 * a kit's menus.
 */
export async function pinKitModes(page: Page, modes: KitModes) {
  for (const [kit, mode] of Object.entries(modes)) await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [`kui.mode.${kit}`, mode] as const)
}

/**
 * Kition on a desktop workspace whose files kits read through the file server. Files Kition saves
 * through its file API are recorded in `saves`, and with `persist` also written to the workspace.
 * The runtime's file grants (`/v1/kits/grants`) are served over the workspace; `grants` holds
 * their sessions. `modes` pins kit editors' display modes (`{ 'kit.word': 'classic' }`, `pinKitModes`).
 */
export async function openKitWorkspace(
  page: Page,
  baseURL: string,
  files: Record<string, Buffer> = {},
  { persist = false, desktop = {} as DesktopHostOptions, routes = async (_page: Page) => {}, modes = {} as KitModes } = {},
) {
  const host = await installDesktopHost(page, desktop)
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(host.root, name)), { recursive: true })
    await fs.writeFile(path.join(host.root, name), content)
  }
  await mockLocalWorkspaceApi(page)
  await serveWorkspace(page, host.root)
  const grants = await serveKitGrants(page, host.root)
  const saves: Array<{ path: string | null; bytes: Buffer }> = []
  await page.route('**/api/v1/kits/files?**', async (route) => {
    const target = new URL(route.request().url()).searchParams.get('path')
    const body = route.request().postDataBuffer() ?? Buffer.alloc(0)
    saves.push({ path: target, bytes: body })
    if (persist && target) await fs.writeFile(path.join(host.root, target), body)
    await fulfillJson(route, { code: 200, message: 'success', data: { path: target, bytes: body.length } })
  })
  // A spec's own answers, over the mocks above.
  await routes(page)
  await pinKitModes(page, modes)
  await page.goto(new URL('/documents', baseURL).toString(), { waitUntil: 'domcontentloaded' })
  await dismissFirstRunActivation(page)
  return { host, saves, grants }
}

/** Opens the workspace file `name` from the tree, where the kit's own editor shows in a frame. */
export async function openTreeFile(page: Page, name: string) {
  // A document in a folder: open the folder in the tree first.
  for (const folder of name.split('/').slice(0, -1)) await page.locator('.document-tree-row', { hasText: folder }).first().click()
  await page.locator('.document-tree-row', { hasText: (name.split('/').pop() ?? name).replace(/\.[^.]+$/, '') }).first().click()
  await expect(page.getByTestId('kit-frame')).toBeVisible()
  return page.frameLocator('[data-testid="kit-frame-window"]')
}

/**
 * Opens `name` (written to the workspace from `bytes`) in Kition, where the kit's own editor
 * shows in a frame; answers the frame, and the files Kition saved through its file API (with
 * `persist`, also written to the workspace).
 */
export async function openInKitFrame(
  page: Page,
  baseURL: string,
  name: string,
  bytes: Buffer,
  others: Record<string, Buffer> = {},
  options: Parameters<typeof openKitWorkspace>[3] = {},
) {
  const { host, saves } = await openKitWorkspace(page, baseURL, { ...others, [name]: bytes }, options)
  return { host, saves, kit: await openTreeFile(page, name) }
}

/**
 * The replica version of the kit editor showing `path` (Kition's development test hook), as each
 * author's change count; '' while there is none. A version's bytes list its authors in no fixed
 * order, so two equal versions can encode differently: compare these, never the hex.
 */
export async function replicaVersion(page: Page, path: string) {
  const hex = await page.evaluate(async (wanted) => (window.__KITION_KIT_TEST__ ? window.__KITION_KIT_TEST__.replicaVersion(wanted) : ''), path)
  return hex ? JSON.stringify(versionCounters(hex)) : ''
}
