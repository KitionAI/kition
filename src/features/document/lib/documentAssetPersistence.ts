import { importWorkspaceImageFromBlobURL } from '@/services/desktop'
import { parentDocumentFolderPath } from '@/services/workspaceFiles'

export async function persistBlobImageLinks(markdown: string, documentPath?: string) {
  const matches = Array.from(markdown.matchAll(/!\[([^\]]*)\]\((blob:[^)]+)\)/g))
  if (!matches.length) {
    return markdown
  }

  const folder = parentDocumentFolderPath(documentPath || '')
  let nextMarkdown = markdown

  for (const [index, match] of matches.entries()) {
    const fullMatch = match[0]
    const altText = match[1] || ''
    const blobURL = match[2]
    try {
      const { relativePath } = await importWorkspaceImageFromBlobURL({
        folder,
        blobURL,
        index: index + 1,
      })
      if (relativePath) {
        nextMarkdown = nextMarkdown.replace(fullMatch, `![${altText}](${relativePath})`)
      }
    } catch {
      // leave the blob: link in place; the next save attempt can retry
    }
  }

  return nextMarkdown
}
