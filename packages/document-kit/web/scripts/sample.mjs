#!/usr/bin/env node
// Writes public/sample/Sample.md, the document the development host (dev.html) opens, with the
// built engine (pnpm run engine first).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const engine = path.join(web, 'public', 'engine')
const sdk = await import(pathToFileURL(path.join(engine, 'kition_document_engine.js')).href)
await sdk.default({ base: pathToFileURL(engine + path.sep).href, read: async (file) => new Uint8Array(fs.readFileSync(path.join(engine, file))) })
const doc = sdk.MarkdownDocument.create('Sample.md', 612, 792)
doc.execute('text.insert', JSON.stringify({ at: 0, text: '# Sample\n\nA **Markdown** document with a [link](https://kition.ai) and a list:\n\n- Goals\n- Risks\n' }))
doc.execute('comment.add', JSON.stringify({ quote: 'Goals', body: 'Which quarter?' }))
fs.mkdirSync(path.join(web, 'public', 'sample'), { recursive: true })
fs.writeFileSync(path.join(web, 'public', 'sample', 'Sample.md'), doc.save())
console.log('sample: wrote public/sample/Sample.md')
