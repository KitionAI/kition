import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'

const DIST_DIR = resolve(process.cwd(), 'dist')
const html = readFileSync(resolve(DIST_DIR, 'index.html'), 'utf8')
const entry = html.match(/<script[^>]+src="([^"]+\.js)"/)?.[1]
const preloads = Array.from(html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+\.js)"/g), (match) => match[1])
const initialAssets = Array.from(new Set([entry, ...preloads].filter(Boolean)))
const stylesheets = Array.from(
  html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+\.css)"/g),
  (match) => match[1],
)

if (!entry || initialAssets.length === 0) {
  throw new Error('Unable to resolve initial JavaScript assets from dist/index.html')
}

const assets = initialAssets.map((asset) => {
  const bytes = readFileSync(resolve(DIST_DIR, asset.replace(/^\//, '')))
  return {
    asset: basename(asset),
    bytes: bytes.byteLength,
    gzipBytes: gzipSync(bytes, { level: 9 }).byteLength,
  }
})
const cssAssets = stylesheets.map((asset) => {
  const bytes = readFileSync(resolve(DIST_DIR, asset.replace(/^\//, '')))
  return {
    asset: basename(asset),
    bytes: bytes.byteLength,
    gzipBytes: gzipSync(bytes, { level: 9 }).byteLength,
  }
})

const totalBytes = assets.reduce((total, asset) => total + asset.bytes, 0)
const totalGzipBytes = assets.reduce((total, asset) => total + asset.gzipBytes, 0)
const totalCssBytes = cssAssets.reduce((total, asset) => total + asset.bytes, 0)
const totalCssGzipBytes = cssAssets.reduce((total, asset) => total + asset.gzipBytes, 0)
const limits = {
  initialBytes: 2_200_000,
  initialGzipBytes: 700_000,
  initialAssetCount: 6,
  initialCssBytes: 380_000,
  initialCssGzipBytes: 60_000,
}

const format = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`
console.log('[performance-budget] initial assets')
for (const asset of assets) {
  console.log(`  ${asset.asset}: ${format(asset.bytes)} decoded / ${format(asset.gzipBytes)} gzip`)
}
console.log(`[performance-budget] total: ${format(totalBytes)} decoded / ${format(totalGzipBytes)} gzip`)
console.log('[performance-budget] initial stylesheets')
for (const asset of cssAssets) {
  console.log(`  ${asset.asset}: ${format(asset.bytes)} decoded / ${format(asset.gzipBytes)} gzip`)
}
console.log(`[performance-budget] CSS total: ${format(totalCssBytes)} decoded / ${format(totalCssGzipBytes)} gzip`)

const failures = []
if (totalBytes > limits.initialBytes) {
  failures.push(`decoded initial JS ${format(totalBytes)} exceeds ${format(limits.initialBytes)}`)
}
if (totalGzipBytes > limits.initialGzipBytes) {
  failures.push(`gzip initial JS ${format(totalGzipBytes)} exceeds ${format(limits.initialGzipBytes)}`)
}
if (assets.length > limits.initialAssetCount) {
  failures.push(`initial JS asset count ${assets.length} exceeds ${limits.initialAssetCount}`)
}
if (totalCssBytes > limits.initialCssBytes) {
  failures.push(`decoded initial CSS ${format(totalCssBytes)} exceeds ${format(limits.initialCssBytes)}`)
}
if (totalCssGzipBytes > limits.initialCssGzipBytes) {
  failures.push(`gzip initial CSS ${format(totalCssGzipBytes)} exceeds ${format(limits.initialCssGzipBytes)}`)
}
if (assets.some((asset) => /mermaid|cytoscape|workflowroute|desktopsettings|scenarioroute|documentdocument|tableeditor|katex|marked|workspaceagentsidebar|documentexport/i.test(asset.asset))) {
  failures.push('an optional heavy feature leaked into the initial preload graph')
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`[performance-budget] ${failure}`)
  process.exitCode = 1
} else {
  console.log('[performance-budget] within budget')
}
