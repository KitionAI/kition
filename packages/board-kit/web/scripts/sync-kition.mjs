#!/usr/bin/env node
// Copies Kition's Tailwind theme (tooling/tailwind.config.ts) into web/kition/ (gitignored), so its
// plugins resolve from this folder's node_modules: the kit builds from a Kition checkout that has
// no dependencies installed (scripts/publish-kit.sh). Everything else the editor needs (the board
// editor's and shared UI's source, Kition's stylesheet and strings) is read in place.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const kition = path.resolve(web, '..', '..', '..')
const out = path.join(web, 'kition')
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })
fs.copyFileSync(path.join(kition, 'tooling', 'tailwind.config.ts'), path.join(out, 'tailwind.config.ts'))
console.log('sync-kition: copied the Tailwind theme from the Kition checkout')
