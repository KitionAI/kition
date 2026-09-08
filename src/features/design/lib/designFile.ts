import {
  listWorkspaceDocuments,
  writeWorkspaceDocument,
  type WorkspaceDocumentTreeItem,
} from '@/services/desktop'
import { createDesign, designId, type DesignDocument } from './designTypes'
import { serializeDesign } from './designSerialization'
export async function createDesignFile(
  root: string,
  folder = '',
  initial?: DesignDocument,
) {
  const response = await listWorkspaceDocuments()
  if (response.root_path !== root) throw new Error('Workspace changed')
  const flatten = (items: WorkspaceDocumentTreeItem[]): string[] =>
    items.flatMap((item) => [item.path, ...flatten(item.children || [])])
  const paths = new Set(flatten(response.items)),
    base = initial?.title || 'Untitled design'
  const title =
    base
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/\.kidesign$/i, '')
      .trim() || 'Untitled design'
  const prefix = folder ? `${folder}/` : ''
  let name = title,
    index = 1
  while (paths.has(`${prefix}${name}.kidesign`)) name = `${title} ${++index}`
  const document = initial
    ? { ...structuredClone(initial), id: designId(), title: name, revision: 0 }
    : createDesign(name)
  return writeWorkspaceDocument(
    `${prefix}${name}.kidesign`,
    serializeDesign(document),
    { expected_root: root, expected_content: null },
  )
}
