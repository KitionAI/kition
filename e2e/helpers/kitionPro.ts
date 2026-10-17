/**
 * The Kition Pro sync server (`kition-pro-server`, a private sibling checkout `../kition-pro`, or
 * `KITION_PRO_REPO`) for co-editing end-to-end tests: built once with cargo, run in memory on a
 * free port with its development tokens, and stopped after the test. Specs skip when the
 * checkout or the Rust toolchain is missing (`kitionProSkipReason`).
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, type BrowserContext, type Page, type WebSocketRoute } from '@playwright/test'
import { VersionVector } from 'loro-crdt'

const repo = process.env.KITION_PRO_REPO || path.resolve(process.cwd(), '..', 'kition-pro')

/** The development principals `config/dev.toml` declares; Alice and Bob have Kition Pro. */
export const DEV_PRINCIPALS = { alice: 'dev-alice', bob: 'dev-bob', carol: 'dev-carol' } as const

/** Where cargo is: on PATH, or rustup's default install. */
function cargo() {
  for (const candidate of ['cargo', path.join(os.homedir(), '.cargo', 'bin', 'cargo')]) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' })
      return candidate
    } catch {
      // Try the next one.
    }
  }
  return null
}

/** Why the server cannot run here, or `null` when it can. */
export function kitionProSkipReason() {
  if (!existsSync(path.join(repo, 'Cargo.toml'))) return `no kition-pro checkout at ${path.relative(process.cwd(), repo) || repo} (set KITION_PRO_REPO)`
  if (!cargo()) return 'no Rust toolchain (cargo) to build kition-pro-server'
  return null
}

let built: string | null = null

/** Builds `kition-pro-server` once per test worker; answers its executable. */
function build() {
  if (built) return built
  const target = process.env.CARGO_TARGET_DIR || path.join(repo, 'target')
  execFileSync(cargo()!, ['build', '-p', 'kition-pro-server'], { cwd: repo, stdio: 'inherit', timeout: 600_000 })
  built = path.join(target, 'debug', 'kition-pro-server')
  return built
}

const CONFIG = `listen = "127.0.0.1:0"
public_url = "http://kition-pro.test"

[auth]
mode = "dev"

[[auth.users]]
token = "dev-alice"
id = "dev:alice"
name = "Alice"
pro = true

[[auth.users]]
token = "dev-bob"
id = "dev:bob"
name = "Bob"
pro = true

[[auth.users]]
token = "dev-carol"
id = "dev:carol"
name = "Carol"
pro = false

[storage]
mode = "memory"
`

export type KitionProServer = { url: string; stop: () => Promise<void> }

/** Starts a fresh in-memory server; `dir` holds its configuration (a test's output folder). */
export async function startKitionPro(dir: string): Promise<KitionProServer> {
  const executable = build()
  await fs.mkdir(dir, { recursive: true })
  const config = path.join(dir, 'kition-pro.toml')
  await fs.writeFile(config, CONFIG)
  const child: ChildProcess = spawn(executable, ['--config', config, '--memory'], { cwd: repo, env: { ...process.env, RUST_LOG: 'info', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise<number>((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error(`kition-pro-server did not start:\n${output}`)), 30_000)
    const read = (chunk: Buffer) => {
      output += chunk.toString()
      // "kition-pro-server listening on /v1/sync addr=127.0.0.1:<port> storage=..."
      const match = output.replace(/\u001b\[[0-9;]*m/g, '').match(/addr=127\.0\.0\.1:(\d+)/)
      if (match) {
        clearTimeout(timer)
        resolve(Number(match[1]))
      }
    }
    child.stdout?.on('data', read)
    child.stderr?.on('data', read)
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`kition-pro-server exited (${code}):\n${output}`))
    })
  })
  return {
    url: `ws://127.0.0.1:${port}/v1/sync`,
    stop: async () => {
      if (child.exitCode !== null) return
      const exited = new Promise((resolve) => child.once('exit', resolve))
      child.kill('SIGTERM')
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))])
      if (child.exitCode === null) child.kill('SIGKILL')
    },
  }
}

/** The stored Kition account session the app reads its token from (`kition.portal.account.session.v1`). */
export function portalSession(token: string) {
  return {
    'kition.portal.account.session.v1': JSON.stringify({ access_token: token, token_prefix: token.slice(0, 4), user_id: 1, user_email: `${token}@example.test`, expires_at: Date.now() + 86_400_000 }),
  }
}

/**
 * The workspace options for a person signed in to Kition Pro with `token`: the stored session, and
 * the runtime confirming it when the app restores it at start.
 */
export function signedIn(token: string) {
  return {
    persist: true,
    desktop: { secureValues: portalSession(token) },
    routes: async (page: Page) => {
      await page.route('**/api/v1/desktop/portal/session/status', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 200, data: { authenticated: true, user_email: `${token}@example.test` } }) }),
      )
    },
  }
}

/** Points the app at `url` for co-editing before it loads. */
export async function useSyncServer(page: Page, url: string) {
  await page.addInitScript((value) => localStorage.setItem('kition.collab.serverUrl.v1', value), url)
}

/** WebSocket URLs the page opens, as they open. */
export function recordWebSockets(page: Page) {
  const opened: string[] = []
  page.on('websocket', (socket) => opened.push(socket.url()))
  return opened
}

/** Whether the kit package in `public/kits/<kit>-ui` serves `replica/info` (Kit UI 1.3): its engine has `docId`. */
export function kitPackageHasReplicaInfo(kit: string, module: string) {
  const glue = path.join(process.cwd(), 'public', 'kits', `${kit}-ui`, 'engine', `${module}.js`)
  if (!existsSync(glue)) return false
  return /\bdocId\b/.test(readFileSync(glue, 'utf8'))
}

/** A replica version (lowercase hex of a KDM version) as each author's change count. */
export function versionCounters(hex: string) {
  return hex ? Object.fromEntries([...VersionVector.decode(Buffer.from(hex, 'hex')).toJSON().entries()].sort()) : {}
}

/** The replica version of the kit editor showing `path` in `page`, as counters (Kition's development test hook). */
export async function replicaCounters(page: Page, path: string): Promise<Record<string, number>> {
  const hex = await page.evaluate(async (wanted) => (window.__KITION_KIT_TEST__ ? window.__KITION_KIT_TEST__.replicaVersion(wanted) : ''), path).catch(() => '')
  return versionCounters(hex)
}

/**
 * Opens the menu of the tab titled `title` until `item` shows in it (a right-click right after
 * working in a kit's frame can go unanswered, and the share item shows once the tab's kit editor
 * is open and the session is known).
 */
export async function openTabMenu(page: Page, title: string, item: string) {
  const entry = page.getByRole('menuitem', { name: item })
  await expect(async () => {
    await page.keyboard.press('Escape')
    await page.locator('.document-tab-list .document-tab', { hasText: title }).first().click({ button: 'right' })
    await expect(entry).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 30_000 })
  return entry
}

/** Shares the document in the tab titled `title` (its tab menu), and answers the share link. */
export async function shareFromTab(page: Page, title: string) {
  await (await openTabMenu(page, title, 'Share for co-editing')).click()
  const field = page.getByTestId('collab-share-link')
  await field.waitFor({ timeout: 30_000 })
  const link = await field.inputValue()
  await page.keyboard.press('Escape')
  await expect(field).toHaveCount(0)
  return link
}

/** Shares the document in the tab titled `title` and answers a view-only link to it (the dialog's Can view). */
export async function shareViewOnlyFromTab(page: Page, title: string) {
  await (await openTabMenu(page, title, 'Share for co-editing')).click()
  const field = page.getByTestId('collab-share-link')
  await field.waitFor({ timeout: 30_000 })
  const editLink = await field.inputValue()
  await page.getByTestId('collab-share-access-view').click()
  await expect(field).not.toHaveValue(editLink, { timeout: 15_000 })
  const link = await field.inputValue()
  await page.keyboard.press('Escape')
  await expect(field).toHaveCount(0)
  return { editLink, viewLink: link }
}

/** Opens a share link from the command palette (Open shared document). */
export async function openSharedLink(page: Page, link: string) {
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByTestId('command-palette-row').filter({ hasText: 'Open shared document' }).click({ timeout: 15_000 })
  await page.getByTestId('collab-open-link').fill(link)
  await page.getByTestId('collab-open-submit').click()
}

/**
 * The context's connection to the sync server, through Playwright so a test can cut it: offline,
 * the open sync sockets close and new ones are refused, as on a network that went away (the
 * browser's own offline mode keeps open WebSockets up). The rest of the context's network goes
 * offline too.
 */
export async function syncNetwork(context: BrowserContext) {
  let online = true
  const open = new Set<{ page: WebSocketRoute; server: WebSocketRoute }>()
  await context.routeWebSocket(/\/v1\/sync$/, async (page) => {
    if (!online) {
      await page.close({ code: 1001, reason: 'offline' })
      return
    }
    const socket = { page, server: page.connectToServer() }
    open.add(socket)
    page.onClose(() => open.delete(socket))
  })
  return {
    setOnline: async (value: boolean) => {
      online = value
      await context.setOffline(!value)
      if (value) return
      for (const socket of [...open]) {
        await socket.server.close().catch(() => undefined)
        await socket.page.close({ code: 1001, reason: 'offline' }).catch(() => undefined)
      }
      open.clear()
    },
  }
}
