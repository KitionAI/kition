import { expect, test } from '@playwright/test'

// Text outside the Basic Multilingual Plane and CJK checks that the page and the WebAssembly
// engine agree on string encoding: two CJK characters (U+5B63 U+5EA6) and an emoji (U+1F600).
const MULTILINGUAL_TEXT = String.fromCodePoint(0x5b63, 0x5ea6, 0x1f600)

// The Kit Data Model (src/lib/kdm) and its loro-crdt WebAssembly load and run in the page.
test('the KDM runs in the page', async ({ page }) => {
  await page.goto('/')
  const text = await page.evaluate(async (body) => {
    const kdm = await import(/* @vite-ignore */ ['/src/lib/kdm', 'index.ts'].join('/'))
    const schema = kdm.parseSchema({ kdm: 1, kit: 'kit.smoke', schemaVersion: 1, root: 'Note', types: { Note: { fields: { body: { kind: 'text' } } } } })
    const doc = kdm.Replica.create(schema, kdm.newDocId(), 1n)
    const note = doc.transact(kdm.person('user:e2e'), (tx) => tx.create('Note', {}))
    doc.transact(kdm.person('user:e2e'), (tx) => tx.textInsert(note, 'body', 0, body))
    return kdm.Replica.load(schema, doc.snapshot(), 2n).text(note, 'body')
  }, MULTILINGUAL_TEXT)
  expect(text).toBe(MULTILINGUAL_TEXT)
})
