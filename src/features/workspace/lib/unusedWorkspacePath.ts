import { listWorkspaceDocuments, type WorkspaceDocumentTreeItem } from '@/services/desktop'

function paths(items: readonly WorkspaceDocumentTreeItem[], out = new Set<string>()) {
  for (const item of items) {
    out.add(item.path)
    if (item.children) paths(item.children, out)
  }
  return out
}

/** `folder/<base>.<extension>`, or `<base> 2.<extension>` and so on when that file exists. */
export async function unusedWorkspacePath(folder: string, base: string, extension: string) {
  const taken = paths((await listWorkspaceDocuments()).items)
  const prefix = folder ? `${folder.replace(/\/+$/, '')}/` : ''
  for (let n = 1; n < 1000; n += 1) {
    const candidate = `${prefix}${base}${n === 1 ? '' : ` ${n}`}.${extension}`
    if (!taken.has(candidate)) return candidate
  }
  throw new Error(`too many files named ${base} in this folder`)
}

/** The folder of a workspace path, and its file name without the extension. */
export function splitWorkspacePath(path: string) {
  const parts = path.split('/').filter(Boolean)
  const name = parts.pop() ?? ''
  const dot = name.lastIndexOf('.')
  return { folder: parts.join('/'), name, stem: dot > 0 ? name.slice(0, dot) : name }
}
