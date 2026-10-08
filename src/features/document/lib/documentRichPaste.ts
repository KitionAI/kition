import { deferImageImport } from './pendingImageImports'
import { clipboardHtmlToMarkdown, parseClipboardHtml } from './documentClipboard'
import { importDocumentClipboardImages, type DocumentClipboardImage } from './documentImagePaste'

/** Snapshot event data synchronously: DataTransfer is unavailable after paste. */
export function prepareDocumentRichPaste(data: DataTransfer, documentPath: string) {
  const html = data.getData('text/html')
  const parsed = parseClipboardHtml(html)
  const files = Array.from(data.files || [])
  for (const item of Array.from(data.items || [])) {
    const file = item.kind === 'file' ? item.getAsFile() : null
    if (file && !files.includes(file)) files.push(file)
  }
  const images = new Map<string, DocumentClipboardImage>()
  for (const element of Array.from(parsed.querySelectorAll('img[src]'))) {
    const raw = element.getAttribute('src') || ''
    const source = raw.startsWith('//') ? `https:${raw}` : raw
    if (!/^(?:https?:\/\/|data:image\/|blob:|cid:)/i.test(source) || images.has(raw)) continue
    const alt = element.getAttribute('alt') || 'image'
    // Never substitute the bitmap of an entire mixed selection for an embedded image.
    // Only use a file when the HTML explicitly identifies it by filename or CID.
    const name = source.startsWith('cid:') ? source.slice(4) : source.split('/').pop()?.split(/[?#]/)[0]
    const file = files.find((candidate) => candidate.type.startsWith('image/') && candidate.name === name)
    images.set(raw, file ? { kind: 'file', file, alt } : { kind: 'source', source, alt })
  }
  if (!images.size) return null
  return async () => {
    const replacements = new Map<string, string>()
    const entries = Array.from(images)
    let next = 0
    await Promise.all(Array.from({ length: Math.min(4, entries.length) }, async () => {
      while (next < entries.length) {
        const index = next++
        const [source, image] = entries[index]
        try {
          const [markdown] = await importDocumentClipboardImages([image], { documentPath, startIndex: index + 1 })
          if (markdown) replacements.set(source, markdown)
        } catch (error) {
          replacements.set(source, deferImageImport(image, documentPath, error))
        }
      }
    }))
    return clipboardHtmlToMarkdown(html, replacements)
  }
}
