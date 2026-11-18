import { listWorkspaceDocuments, readWorkspaceDocument, type WorkspaceDocumentTreeItem } from '@/services/desktop'
import { renderDocumentTemplatePlaceholders } from './documentTemplates'

const TEMPLATE_DIR_PREFIX = 'Templates/'

export type TemplateEntry = {
  path: string
  name: string
}

function flatten(items: WorkspaceDocumentTreeItem[], out: WorkspaceDocumentTreeItem[] = []) {
  for (const item of items) {
    out.push(item)
    if (item.children?.length) flatten(item.children, out)
  }
  return out
}

/** The workspace's own note templates: the Markdown files under `Templates/`. */
export async function listTemplates(): Promise<TemplateEntry[]> {
  const { items } = await listWorkspaceDocuments()
  return flatten(items)
    .filter((item) => item.type === 'file' && /\.md$/i.test(item.path) && item.path.startsWith(TEMPLATE_DIR_PREFIX))
    .map((item) => ({ path: item.path, name: item.name.replace(/\.md$/i, '') }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export async function loadTemplateContent(templatePath: string, title: string): Promise<string | null> {
  try {
    const document = await readWorkspaceDocument(templatePath)
    return renderDocumentTemplatePlaceholders(document.content ?? '', title).replace('{{cursor}}', '')
  } catch {
    return null
  }
}
