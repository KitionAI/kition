import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, type FrameLocator, type Page, type Route } from '@playwright/test'

import { kitEngine } from './embeddedKit'
import { fulfillJson } from './mockApi'

/**
 * The onboarding tables in the Table kit with the person's model answering their AI fields
 * (`host/generate` → `POST /api/v1/ai/generate`, contracts/runtime/ai-generate.schema.json).
 */

type NodeTableDocument = { call(method: string, params: string): string; free(): void }
const engine = kitEngine<{ TableDocument: { open(name: string, bytes: Uint8Array): NodeTableDocument } }>('table', 'kition_table_sdk')

export type TableRecord = { id: number; values: Record<string, unknown> }

/** An onboarding table file as Kition seeds it (public/onboarding/…). */
export function onboardingTable(relative: string) {
  return readFile(path.join(process.cwd(), 'public', 'onboarding', relative))
}

/** Every table's records in a saved file, as the engine reads them, by table title. */
export async function savedTables(bytes: Buffer) {
  const sdk = await engine.load()
  const doc = sdk.TableDocument.open('Saved.ktable', bytes)
  const call = <T>(method: string, params: Record<string, unknown> = {}) => {
    const answer = JSON.parse(doc.call(method, JSON.stringify(params))) as { result?: T; error?: unknown }
    if (answer.error) throw new Error(`${method}: ${JSON.stringify(answer.error)}`)
    return answer.result as T
  }
  const tables: Record<string, TableRecord[]> = {}
  for (const table of call<{ tables: Array<{ id: number; title: string }> }>('documents.get').tables) {
    tables[table.title] = call<{ items: TableRecord[] }>('records.list', { tableId: table.id }).items
  }
  doc.free()
  return tables
}

/** The person's models, as the settings page stores them: a text model, and `extra` (an image model, say). */
export async function configureModel(page: Page, extra: string[] = []) {
  await page.addInitScript((discoveredModels) => {
    window.localStorage.setItem(
      'kition.desktop.settings.backup.v1',
      JSON.stringify({
        providers: { openai: { enabled: true, label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKey: 'test-key', wireApi: 'responses', discoveredModels } },
        models: { activeProvider: 'openai', selectedModelByProvider: { openai: 'gpt-test' } },
      }),
    )
  }, ['gpt-test', ...extra])
}

/** The table file list host features read (`/v1/kit-tables`): this workspace has none to report. */
export async function serveKitTables(page: Page) {
  await page.route(/\/api\/v1\/kit-tables(\?.*)?$/, (route) => fulfillJson(route, { code: 200, message: 'success', data: { files: [] } }))
}

export type GenerateAnswer = { text: string } | { image: { mime: string; data: string } } | { refuse: 'timeout' | 'failed' | 'quota'; message: string }

/**
 * Answers `/api/v1/ai/generate` and keeps every request: `answers` in turn (the last one
 * repeats), or what `answers` returns for the request. A refusal answers as the runtime does: an
 * error status with `data.reason`.
 */
export async function mockGenerate(page: Page, answers: GenerateAnswer[] | ((request: Record<string, any>, index: number) => GenerateAnswer)) {
  const requests: Array<Record<string, any>> = []
  await page.route('**/api/v1/ai/generate', async (route: Route) => {
    const request = route.request().postDataJSON() as Record<string, any>
    requests.push(request)
    const answer = typeof answers === 'function' ? answers(request, requests.length - 1) : answers[Math.min(requests.length, answers.length) - 1]
    if ('refuse' in answer) {
      await fulfillJson(route, { code: 504, message: answer.message, data: { reason: answer.refuse } }, 504)
      return
    }
    await fulfillJson(route, { code: 200, message: 'success', data: { ...answer, model: 'gpt-test' } })
  })
  return requests
}

/** All the text a generate request sends the model. */
export function promptText(request: Record<string, any>) {
  return (request.messages as Array<{ parts: Array<{ text?: string }> }>).flatMap((message) => message.parts.map((part) => part.text ?? '')).join('\n')
}

export const recordCount = (kit: FrameLocator) => kit.locator('.data-inline-footer')
const stage = (kit: FrameLocator) => kit.locator('.data-inline-grid-canvas [data-t-grid-stage="true"]')

/** Opens the record menu on the grid's `row`th row (0 is the first). */
export async function recordMenu(kit: FrameLocator, row = 0) {
  const position = { x: 145, y: 48 + row * 33 }
  await stage(kit).click({ position })
  await stage(kit).click({ position, button: 'right' })
  await expect(kit.getByRole('button', { name: 'Duplicate record' })).toBeVisible()
}
