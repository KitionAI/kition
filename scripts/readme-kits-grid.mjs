#!/usr/bin/env node
// Composes docs/readme/kits-grid.webp, the README's picture of the sixteen kits: a 4x4 grid of
// real output, one Kition Showcase sample per kit, in the kits' fixed order (the README's Kits
// table). Each tile is the sample's thumb.png, which the kit rendered itself. No text is added.
//
//   node scripts/readme-kits-grid.mjs [--showcase <dir>]
//
// The showcase is the kition-showcase checkout beside this repository (../kition-showcase), or
// --showcase, or KITION_SHOWCASE_DIR. Needs ImageMagick 7 (`magick`), as pnpm
// capture:readme:assets does. Fails when the picture exceeds MAX_BYTES.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const flag = process.argv.indexOf('--showcase')
const showcase = path.resolve(
  flag > 0 ? process.argv[flag + 1] : process.env.KITION_SHOWCASE_DIR || path.join(root, '..', 'kition-showcase'),
)
const output = path.join(root, 'docs/readme/kits-grid.webp')
const MAX_BYTES = 400 * 1024

// [kit, sample, gravity]: the crop keeps the top of page-shaped samples and of the table, the
// left edge of the slide, and the middle of the rest.
const SAMPLES = [
  ['note', 'release-plan-review', 'North'],
  ['table', 'app-launch-task-tracker', 'NorthWest'],
  ['board', 'cafe-launch-mind-map', 'Center'],
  ['doc', 'magazine-feature', 'North'],
  ['sheet', 'signup-trend-forecast', 'Center'],
  ['slide', 'kpi-dashboard-sparklines', 'West'],
  ['pdf', 'reviewed-quarterly-report', 'North'],
  ['html', 'coffee-roaster-landing-hero', 'Center'],
  ['photo', 'autumn-sale-poster', 'Center'],
  ['vector', 'alpine-lake-sunrise', 'Center'],
  ['layout', 'community-garden-trifold', 'Center'],
  ['design', 'sales-analytics-dashboard', 'Center'],
  ['film', 'aurora-title-card', 'Center'],
  ['motion', 'lumen-studio-logo-reveal', 'Center'],
  ['cad', 'house-lighting-circuit-schematic', 'Center'],
  ['scene', 'glazed-donut-sprinkles', 'Center'],
]

const COLUMNS = 4
const GAP = 16
const TILE_WIDTH = 380
const TILE_HEIGHT = 238
const RADIUS = 12
const BACKGROUND = '#f4f4f6'
const BORDER = '#e2e2e8'
const width = COLUMNS * TILE_WIDTH + (COLUMNS + 1) * GAP
const rows = Math.ceil(SAMPLES.length / COLUMNS)
const height = rows * TILE_HEIGHT + (rows + 1) * GAP

const magick = (args) => execFileSync('magick', args, { stdio: ['ignore', 'ignore', 'inherit'] })

const thumbs = SAMPLES.map(([kit, sample]) => path.join(showcase, kit, sample, 'thumb.png'))
const missing = thumbs.filter((file) => !fs.existsSync(file))
if (missing.length) {
  console.error(`[kits-grid] missing in ${showcase}:\n  ${missing.map((file) => path.relative(showcase, file)).join('\n  ')}`)
  process.exit(1)
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kition-kits-grid-'))
try {
  const mask = path.join(scratch, 'mask.png')
  magick(['-size', `${TILE_WIDTH}x${TILE_HEIGHT}`, 'xc:black', '-fill', 'white', '-draw', `roundrectangle 0,0 ${TILE_WIDTH - 1},${TILE_HEIGHT - 1} ${RADIUS},${RADIUS}`, mask])
  const args = ['-size', `${width}x${height}`, `xc:${BACKGROUND}`]
  SAMPLES.forEach(([kit, , gravity], index) => {
    const tile = path.join(scratch, `${String(index).padStart(2, '0')}-${kit}.png`)
    magick([
      thumbs[index], '-resize', `${TILE_WIDTH}x${TILE_HEIGHT}^`, '-gravity', gravity, '-extent', `${TILE_WIDTH}x${TILE_HEIGHT}`,
      mask, '-alpha', 'off', '-compose', 'CopyOpacity', '-composite', tile,
    ])
    const x = GAP + (index % COLUMNS) * (TILE_WIDTH + GAP)
    const y = GAP + Math.floor(index / COLUMNS) * (TILE_HEIGHT + GAP)
    args.push(tile, '-geometry', `+${x}+${y}`, '-compose', 'Over', '-composite')
    args.push('-fill', 'none', '-stroke', BORDER, '-strokewidth', '1', '-draw', `roundrectangle ${x},${y} ${x + TILE_WIDTH - 1},${y + TILE_HEIGHT - 1} ${RADIUS},${RADIUS}`)
  })
  args.push('-strip', '-quality', '86', '-define', 'webp:method=6', output)
  magick(args)
} finally {
  fs.rmSync(scratch, { recursive: true, force: true })
}

const bytes = fs.statSync(output).size
console.log(`[kits-grid] ${path.relative(root, output)}: ${width}x${height}, ${Math.round(bytes / 1024)} KB`)
if (bytes > MAX_BYTES) {
  console.error(`[kits-grid] larger than ${MAX_BYTES / 1024} KB; lower the quality`)
  process.exit(1)
}
