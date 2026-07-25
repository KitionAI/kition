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

export async function validateDesktopRenderer({ rootDir = appDir } = {}) {
  const distDir = path.join(rootDir, 'dist')
  const indexPath = path.join(distDir, 'index.html')
  const html = await fs.readFile(indexPath, 'utf8')
  const references = collectLocalAssetReferences(html)
  const absoluteReferences = references.filter((value) => value.startsWith('/'))

  if (absoluteReferences.length) {
    throw new Error(
      `desktop renderer contains root-relative assets that cannot load over file://: ${absoluteReferences.join(', ')}`,
    )
  }

  const missingReferences = []
  for (const reference of references) {
    const cleanReference = reference.split(/[?#]/, 1)[0]
    const assetPath = path.resolve(distDir, cleanReference)
    try {
      const stat = await fs.stat(assetPath)
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

  console.log(`[desktop-renderer] verified ${references.length} relative asset references`)
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
