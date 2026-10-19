import { importDocumentClipboardImages } from './documentImagePaste'

export async function persistBlobImageLinks(markdown: string, documentPath?: string) {
  const matches = Array.from(markdown.matchAll(/!\[([^\]]*)\]\((blob:[^)]+)\)/g))
  if (!matches.length) {
    return markdown
  }

  let nextMarkdown = markdown

  for (const [index, match] of matches.entries()) {
    const fullMatch = match[0]
    const altText = match[1] || ''
    const blobURL = match[2]
    try {
      const [snippet] = await importDocumentClipboardImages(
        [{ kind: 'source', source: blobURL, alt: altText }],
        { documentPath, startIndex: index + 1 },
      )
      if (snippet) {
        nextMarkdown = nextMarkdown.replace(fullMatch, snippet)
      }
    } catch {
      // leave the blob: link in place; the next save attempt can retry
    }
  }

  return nextMarkdown
}
