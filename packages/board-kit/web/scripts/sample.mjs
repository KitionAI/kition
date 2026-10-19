#!/usr/bin/env node
// Writes public/sample/Sample.kiboard, the board the development host (dev.html) opens, with the
// built engine (pnpm run engine first).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const engine = path.join(web, 'public', 'engine')
const sdk = await import(pathToFileURL(path.join(engine, 'kition_board_engine.js')).href)
await sdk.default({ base: pathToFileURL(engine + path.sep).href, read: async (file) => new Uint8Array(fs.readFileSync(path.join(engine, file))) })
const doc = sdk.BoardDocument.create('Sample.kiboard', 1920, 1080)
const note = (id, text, x) => ({ id, kind: 'rectangle', x, y: 120, width: 180, height: 110, text, shapeType: 'rectangle', shapeStyle: 'sticky' })
doc.execute('element.create', JSON.stringify({ elements: [note('sample-goals', 'Goals', 120), note('sample-risks', 'Risks', 380)] }))
fs.mkdirSync(path.join(web, 'public', 'sample'), { recursive: true })
fs.writeFileSync(path.join(web, 'public', 'sample', 'Sample.kiboard'), doc.save())
console.log('sample: wrote public/sample/Sample.kiboard')
