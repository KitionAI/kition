/**
 * Plays the runtime's end of the document bridge (`crates/kition-kits/src/document_bridge.rs`)
 * for a page: `GET /v1/kits/bridge` streams JSON-RPC requests as server-sent events, and the
 * window answers each with `POST /v1/kits/bridge?session=<id>`. Each stream carries
 * `bridge.ready` and the requests queued since the last one, then ends; the browser reconnects
 * at once (`retry`), so a request reaches the window within moments of being queued.
 */
import { expect, type Page } from '@playwright/test'

type Message = { jsonrpc: '2.0'; id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown }

export async function mockDocumentBridge(page: Page) {
  const queue: Message[] = []
  const answers = new Map<number, Message>()
  const announcements: string[][] = []
  let session = 0
  let nextId = 1

  await page.route('**/v1/kits/bridge', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    session += 1
    const messages: Message[] = [{ jsonrpc: '2.0', method: 'bridge.ready', params: { session } }, ...queue.splice(0)]
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body: `retry: 50\n\n${messages.map((message) => `data: ${JSON.stringify(message)}\n\n`).join('')}`,
    })
  })
  await page.route('**/v1/kits/bridge?**', async (route) => {
    const message = route.request().postDataJSON() as Message
    if (message.method === 'documents.open') announcements.push((message.params?.paths as string[]) ?? [])
    else if (message.id != null) answers.set(message.id, message)
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 200, message: 'success', data: {} }) })
  })

  return {
    /** The paths the window last announced as open (`documents.open`). */
    openPaths: () => announcements.at(-1) ?? [],
    /** Sends a request to the window and answers its reply (`result` or `error`). */
    async request(method: string, params: Record<string, unknown>) {
      const id = nextId++
      queue.push({ jsonrpc: '2.0', id, method, params })
      await expect.poll(() => answers.has(id), { timeout: 15_000 }).toBe(true)
      return answers.get(id)!
    },
  }
}
