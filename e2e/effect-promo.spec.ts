import { expect, test } from '@playwright/test'
import { productLaunch, toolCalls } from '../scripts/effect-promo/recipe.mjs'
import { kitEngine, openInKitFrame } from './helpers/embeddedKit'
import { fulfillJson } from './helpers/mockApi'

type EffectDocument = { save(): Uint8Array; execute(command: string, params: string): string; inspect(): string; free(): void }
const engine = kitEngine<{ EffectDocument: {
  create(name: string, width: number, height: number): EffectDocument
  open(name: string, bytes: Uint8Array): EffectDocument
} }>('effect', 'kition_effect_sdk')

for (const [orientation, width, height] of [['landscape', 320, 180], ['portrait', 180, 320]] as const) {
  test(`an external agent builds and revises a ${orientation} promotional film through the live Effect bridge`, async ({ page, baseURL }) => {
    test.setTimeout(180_000)
    expect(engine.built, 'Fetch or build the Effect package before running this gate').toBe(true)
    const sdk = await engine.load()
    const name = 'Launch.keffect'
    const recipe = productLaunch({ width, height })
    const calls = toolCalls(recipe, name)
    const blank = sdk.EffectDocument.create(name, recipe.width, recipe.height)
    const bytes = Buffer.from(blank.save())
    blank.free()
    const posted: Array<{ id?: number; result?: Record<string, unknown>; error?: unknown }> = []
    let release = () => {}
    const released = new Promise<void>(resolve => { release = resolve })
    const previewBefore = calls.length + 2
    const revision = previewBefore + 1
    const previewAfter = revision + 1
    const messages = [
      { jsonrpc: '2.0', method: 'bridge.ready', params: { session: 41 } },
      ...calls.map((call, index) => ({
        jsonrpc: '2.0', id: index + 1, method: 'kit/call',
        params: { path: name, kit: 'kit.effect', tool: 'run', arguments: call.arguments },
      })),
      { jsonrpc: '2.0', id: calls.length + 1, method: 'kit/call', params: { path: name, kit: 'kit.effect', tool: 'run', arguments: { steps: [{ command: 'time.set', params: { time: 10.5 } }], save: false } } },
      { jsonrpc: '2.0', id: previewBefore, method: 'kit/preview', params: { path: name, maxSize: 320 } },
      { jsonrpc: '2.0', id: revision, method: 'kit/call', params: { path: name, kit: 'kit.effect', tool: 'run', arguments: {
        steps: [{ command: 'layer.setText', params: { layer: 'promo.closing.headline', text: 'Make your next move.' } }], save: true,
      } } },
      { jsonrpc: '2.0', id: previewAfter, method: 'kit/preview', params: { path: name, maxSize: 320 } },
    ]
    let streams = 0
    const { host, kit, saves } = await openInKitFrame(page, baseURL!, name, bytes, {}, {
      routes: async page => {
        await page.route('**/v1/kits/bridge', async route => {
          if (route.request().method() !== 'GET') return route.fallback()
          if (++streams > 1) return route.fulfill({ status: 204, body: '' })
          await released
          return route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: messages.map(message => `data: ${JSON.stringify(message)}\n\n`).join('') })
        })
        await page.route('**/v1/kits/bridge?**', async route => {
          posted.push(route.request().postDataJSON())
          await fulfillJson(route, { code: 200, message: 'success', data: {} })
        })
      },
    })
    try {
      await expect(kit.getByTestId('effect-status')).toContainText('0 layers', { timeout: 60_000 })
      release()
      const answer = async (id: number) => {
        await expect.poll(() => posted.find(message => message.id === id), { timeout: 60_000 }).toBeTruthy()
        const response = posted.find(message => message.id === id)!
        expect(response.error, `bridge request ${id}`).toBeUndefined()
        return response.result!
      }
      for (const [index, call] of calls.entries()) {
        const result = await answer(index + 1)
        expect(result.saved).toBe(true)
        expect(result.completed).toHaveLength(call.arguments.steps.length)
      }
      const before = (await answer(previewBefore)).png as string
      expect(Buffer.from(before, 'base64').subarray(1, 4).toString()).toBe('PNG')
      expect((await answer(revision)).saved).toBe(true)
      const after = (await answer(previewAfter)).png as string
      expect(after).not.toBe(before)
      await expect(kit.getByTestId('effect-status')).toContainText(`${recipe.layers.length} layers`)
      await expect(kit.getByTestId('effect-unsaved')).toHaveCount(0)
      const saved = saves.filter(save => save.path === name).at(-1)
      expect(saved?.bytes.length).toBeGreaterThan(0)
      const reopened = sdk.EffectDocument.open(name, saved!.bytes)
      try {
        const info = JSON.parse(reopened.inspect()).info
        expect(info.layers).toHaveLength(recipe.layers.length)
        expect(info.duration).toBe(12)
        expect(reopened.execute('prop.get', JSON.stringify({ layer: 'promo.closing.headline', path: 'text/sourceText' }))).toContain('Make your next move.')
        expect(JSON.parse(reopened.execute('prop.get', JSON.stringify({ layer: 'promo.opening.headline', path: 'text/sourceText' }))).value).toBe(orientation === 'portrait' ? 'Make room\nfor ideas.' : 'Make room for ideas.')
      } finally { reopened.free() }
    } finally {
      release()
      await host.dispose()
    }
  })
}
