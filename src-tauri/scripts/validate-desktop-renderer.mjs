import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const modulePath = fileURLToPath(import.meta.url)
const appDir = path.resolve(path.dirname(modulePath), '..', '..')

function collectLocalAssetReferences(html) {
  const references = []
  const pattern = /\b(?:href|src)=(?:"([^"]+)"|'([^']+)')/g
  for (const match of html.matchAll(pattern)) {
    const value = match[1] || match[2] || ''
    if (!value || value.startsWith('data:') || value.includes('://')) continue
    references.push(value)
  }
  return references
}

/**
 * Checks the built renderer before packaging: every asset `index.html`
 * references exists, and there is a JavaScript entry. The desktop shell serves
 * `dist/` from its own origin, so root-relative references resolve to it.
 */
export async function validateDesktopRenderer({ rootDir = appDir } = {}) {
  const distDir = path.join(rootDir, 'dist')
  const html = await fs.readFile(path.join(distDir, 'index.html'), 'utf8')
  const references = collectLocalAssetReferences(html)

  const missingReferences = []
  for (const reference of references) {
    const cleanReference = reference.split(/[?#]/, 1)[0].replace(/^\/+/, '')
    try {
      const stat = await fs.stat(path.resolve(distDir, cleanReference))
      if (!stat.isFile()) missingReferences.push(reference)
    } catch {
      missingReferences.push(reference)
    }
  }
  if (missingReferences.length) {
    throw new Error(`desktop renderer references missing assets: ${missingReferences.join(', ')}`)
  }
  if (!references.some((value) => /\.m?js(?:[?#]|$)/.test(value))) {
    throw new Error('desktop renderer does not reference a JavaScript entry asset')
  }
  try {
    const logoMark = await fs.stat(path.join(distDir, 'logo-mark.png'))
    if (!logoMark.isFile()) throw new Error('not a file')
  } catch {
    throw new Error('desktop renderer is missing logo-mark.png')
  }

  console.log(`[desktop-renderer] verified ${references.length} asset references`)
  return references
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  try {
    await validateDesktopRenderer()
  } catch (error) {
    console.error(`[desktop-renderer] ${error.message}`)
    process.exitCode = 1
  }
}
