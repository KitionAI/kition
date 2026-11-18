import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { mockDocumentBridge } from '../helpers/documentBridge'
import { kitEngine, openInKitFrame } from '../helpers/embeddedKit'

type Step = { command: string; params?: Record<string, unknown> }
type Entry = { module: string; class: string; name: string; edit: Step | Step[] }
type EngineDocument = { save(): Uint8Array; inspect(): string; free(): void }
type EngineClass = { create(name: string, width: number, height: number): EngineDocument; open(name: string, bytes: Uint8Array): EngineDocument }
type Answer = { result?: Record<string, any>; error?: { code: number; message: string; data?: Record<string, unknown> } }

const registry = JSON.parse(readFileSync('kits/modules.json', 'utf8')) as Record<string, Entry>

function result(answer: Answer) {
  expect(answer.error, JSON.stringify(answer)).toBeUndefined()
  expect(answer.result).toBeDefined()
  return answer.result!
}

// Every registered package is required here, including optional packages when explicitly
// running the complete matrix. Missing engines fail instead of silently losing coverage.
for (const [id, entry] of Object.entries(registry).filter(([id]) => !id.startsWith('$'))) {
  test(`${id}: agent commands, persistence, object model and read-only isolation`, { tag: [`@ai-kit-${id}`, '@p0'] }, async ({ page, baseURL }) => {
    test.setTimeout(60_000)
    const engine = kitEngine<Record<string, EngineClass>>(id, entry.module)
    expect(engine.built, `${id} must be built before testing its agent integration`).toBe(true)
    const Document = (await engine.load())[entry.class]
    const created = Document.create(entry.name, 320, 180)
    const fixture = Buffer.from(created.save())
    created.free()
    const manifest = JSON.parse(await fs.readFile(`public/kits/${id}-ui/kit.json`, 'utf8')) as { model?: unknown; agent?: { drafts?: boolean } }
    const step = Array.isArray(entry.edit) ? entry.edit[0] : entry.edit
    let bridge!: Awaited<ReturnType<typeof mockDocumentBridge>>
    const { host, saves } = await openInKitFrame(page, baseURL!, entry.name, fixture, {}, {
      persist: true,
      routes: async (page) => {
        // Saving is explicit in this matrix. Note's separate autosave suite covers its default.
        if (id === 'note') await page.addInitScript(() => localStorage.setItem('kit.note.autosave', 'off'))
        bridge = await mockDocumentBridge(page)
      },
    })
    const call = async (tool: string, args: Record<string, unknown> = {}) => await bridge.request('kit/call', { path: entry.name, kit: `kit.${id}`, tool, arguments: args }) as Answer
    const inspect = async () => result(await call('inspect')).document
    try {
      await expect(page.getByTestId('kit-opening')).toHaveCount(0, { timeout: 30_000 })
      const documents = result(await bridge.request('kit/documents', {}) as Answer).documents
      expect(documents).toContainEqual({ path: entry.name, kit: `kit.${id}`, dirty: false, revision: expect.any(Number) })
      const commands = result(await call('commands', { query: step.command }))
      expect(commands.commands).toEqual(expect.arrayContaining([expect.objectContaining({ id: step.command })]))
      expect(commands.total).toBe(commands.commands.length)

      const edited = result(await call('run', { steps: [step], save: false }))
      expect(edited.completed).toEqual([expect.objectContaining({ command: step.command, changed: true })])
      expect(edited.saved).toBe(false)
      // canUndo describes the person's history. Kits with per-author undo correctly leave it
      // false after an agent edit; test the agent's actual undo/redo instead of that UI flag.
      expect(edited.document).toMatchObject({ dirty: true, canUndo: expect.any(Boolean) })
      expect(saves).toHaveLength(0)
      expect(await fs.readFile(path.join(host.root, entry.name))).toEqual(fixture)
      for (const command of ['edit.undo', 'edit.redo']) {
        // PDF takes the caller's origin for undo; its command schema accepts no scope argument.
        const params = id === 'pdf' ? {} : { scope: 'agent' }
        const recovered = result(await call('run', { steps: [{ command, params }], save: false }))
        expect(recovered.completed).toEqual([expect.objectContaining({ command, changed: true })])
        expect(recovered.saved).toBe(false)
      }

      // A failure must be explicit, leave the live edit intact, and allow the next request.
      const beforeError = await inspect()
      const unknown = await call('run', { steps: [{ command: 'kition.no-such-command' }], save: false })
      expect(unknown.error).toMatchObject({ message: expect.stringContaining('kition.no-such-command') })
      expect(await inspect()).toEqual(beforeError)
      const wrongKit = await bridge.request('kit/call', { path: entry.name, kit: 'kit.missing', tool: 'inspect' }) as Answer
      expect(wrongKit.error).toMatchObject({ message: expect.stringContaining(`kit.${id}`) })

      const description = await call('describe')
      // Some editors serve a model before their manifest offers the headless model tools.
      // A declared model is mandatory; a runtime model must also answer valid reads.
      const hasModel = Boolean(manifest.model || description.result)
      if (hasModel) {
        const schema = result(description)
        expect(schema).toMatchObject({ root: expect.any(String), types: expect.any(Object) })
        const batch = result(await call('batch', { ops: [], load: [{ target: 'root' }] }))
        expect(batch.loaded).toEqual([expect.objectContaining({ id: expect.any(String), type: schema.root, fields: expect.any(Object) })])
        expect(batch.saved).toBe(false)
        expect(batch).not.toHaveProperty('version')
      } else {
        expect(description.error).toMatchObject({ data: { code: 'unsupported' } })
      }

      const saved = result(await call('run', { steps: [step], save: true }))
      expect(saved.saved).toBe(true)
      expect(saved.document.dirty).toBe(false)
      await expect.poll(() => saves.length).toBe(1)
      expect(saves[0].path).toBe(entry.name)
      const bytes = await fs.readFile(path.join(host.root, entry.name))
      expect(bytes).not.toEqual(fixture)
      const reopened = Document.open(entry.name, bytes)
      expect(JSON.parse(reopened.inspect())).toEqual(expect.any(Object))
      reopened.free()
      const preview = result(await bridge.request('kit/preview', { path: entry.name, maxSize: 128 }) as Answer)
      expect(Buffer.from(preview.png, 'base64').subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))

      if (manifest.agent?.drafts) {
        const beforeDraft = await inspect()
        const draftStep = id === 'sheet' ? { ...step, params: { ...step.params, input: '100' } } : step
        const draft = result(await call('run', { steps: [draftStep], draft: true, save: true }))
        expect(draft.completed).toEqual([expect.objectContaining({ command: step.command, changed: true })])
        expect(draft.saved).toBe(false)
        // Opening the draft bar resizes Note's viewport, changing its revision and size summary.
        // Every engine detail, undo/redo state and dirty flag must still match the live file.
        const content = ({ revision: _revision, summary: _summary, ...state }: Record<string, unknown>) => state
        expect(content(await inspect())).toEqual(content(beforeDraft))
        expect(saves).toHaveLength(1)
        expect(await fs.readFile(path.join(host.root, entry.name))).toEqual(bytes)
        expect(result(await call('draft_ready'))).toMatchObject({ state: 'ready' })
        expect(result(await call('draft_reopen'))).toMatchObject({ state: 'open' })
      }

      // The same agent channel must respect a role change, including edits requested with save=false.
      await page.evaluate((file) => window.__KITION_KIT_TEST__!.setReadOnlyDocuments([file]), entry.name)
      await expect(page.getByTestId('kit-opening')).toBeVisible({ timeout: 15_000 })
      await expect(page.getByTestId('kit-opening')).toHaveCount(0, { timeout: 30_000 })
      const beforeDenied = await inspect()
      const denied = await call('run', { steps: [step], save: false })
      expect(denied.error).toMatchObject({ message: expect.stringMatching(/read.only/i) })
      if (hasModel) {
        const deniedBatch = await call('batch', { ops: [{ op: 'command', id: step.command, params: step.params }], save: false })
        expect(deniedBatch.error).toMatchObject({ message: expect.stringMatching(/read.only/i) })
      }
      expect(await inspect()).toEqual(beforeDenied)
      expect(saves).toHaveLength(1)
      expect(await fs.readFile(path.join(host.root, entry.name))).toEqual(bytes)
    } finally {
      await host.dispose()
    }
  })
}
