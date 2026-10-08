import { deferImageImport } from './pendingImageImports'
import { markdownLanguage } from '@codemirror/lang-markdown'
import { importDocumentClipboardImages } from './documentImagePaste'

/** Localize image destinations without changing text, links, or code examples. */
export function prepareMarkdownImageImport(markdown: string, documentPath: string) {
  const destinations: Array<{ from: number; to: number; source: string }> = []
  const tree = markdownLanguage.parser.parse(markdown)
  const references = new Map<string, { from: number; to: number }>()
  const labelKey = (label: string) => label.slice(1, -1).trim().replace(/\s+/g, ' ').toLowerCase()
  tree.iterate({ enter(node) {
    if (node.name !== 'LinkReference') return
    const label = node.node.getChild('LinkLabel')
    const url = node.node.getChild('URL')
    if (label && url) references.set(labelKey(markdown.slice(label.from, label.to)), url)
  } })
  tree.iterate({
    enter(node) {
      if (node.name !== 'Image') return
      const label = node.node.getChild('LinkLabel')
      const reference = label ? markdown.slice(label.from, label.to) : markdown.slice(node.from + 1, node.to)
      const url = node.node.getChild('URL') || references.get(labelKey(reference === '[]'
        ? markdown.slice(node.from + 1, node.to - 2) : reference))
      if (!url) return
      const raw = markdown.slice(url.from, url.to)
      const source = raw.replace(/^<|>$/g, '').replace(/\\([\\()])/g, '$1')
      if (/^(?:https?:\/\/|data:image\/|blob:)/i.test(source)) {
        if (!destinations.some((destination) => destination.from === url.from)) {
          destinations.push({ from: url.from, to: url.to, source })
        }
      }
      return false
    },
  })
  if (!destinations.length) return null
  return async () => {
    const replacements = new Map<string, string>()
    for (const { source } of destinations) {
      if (replacements.has(source)) continue
      const image = { kind: 'source' as const, source, alt: 'image' }
      let snippet: string
      try {
        [snippet] = await importDocumentClipboardImages([image], { documentPath, startIndex: replacements.size + 1 })
      } catch (error) { snippet = deferImageImport(image, documentPath, error) }
      replacements.set(source, snippet.slice('![image]('.length, -1))
    }
    let result = markdown
    for (const { from, to, source } of destinations.sort((a, b) => b.from - a.from)) {
      result = result.slice(0, from) + replacements.get(source)! + result.slice(to)
    }
    return result
  }
}
