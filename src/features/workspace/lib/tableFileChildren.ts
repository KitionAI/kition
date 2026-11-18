import type { KitTablesFile } from '@/api/kitTables'
import { isTableFilePath } from '@/api/kitTables'
import type { WorkspaceTreeNode } from '@/features/workspace/lib/workspace'

/**
 * A table file's tables and dashboards as its children in the workspace tree. The Table kit
 * answers what a file holds (through the runtime's `/v1/kit-tables`); a child opens the file in
 * the kit at that table or dashboard (Kit UI `document.view`: `tables/<id>` or `dashboards/<id>`).
 */
const TABLE_FILE_VIEW_PREFIX = 'ktable-view://'

export type TableFileChildKind = 'tables' | 'dashboards'

/** The tree path of a table file's table or dashboard: `ktable-view://<kind>/<id>/<file path>`. */
export function tableFileChildPath(filePath: string, kind: TableFileChildKind, id: string) {
  return `${TABLE_FILE_VIEW_PREFIX}${kind}/${encodeURIComponent(id)}/${filePath}`
}

/** The file and the view a child's tree path names; null for any other path. */
export function parseTableFileChildPath(path: string): { filePath: string; kind: TableFileChildKind; view: { path: string } } | null {
  if (!path.startsWith(TABLE_FILE_VIEW_PREFIX)) return null
  const match = /^(tables|dashboards)\/([^/]+)\/(.+)$/.exec(path.slice(TABLE_FILE_VIEW_PREFIX.length))
  if (!match || !isTableFilePath(match[3])) return null
  const kind = match[1] as TableFileChildKind
  return { filePath: match[3], kind, view: { path: `${kind}/${decodeURIComponent(match[2])}` } }
}

/** The disclosure key of a tree node: a file with child pages expands under its folder's path. */
function treeDisclosureKey(node: WorkspaceTreeNode) {
  return node.folderPath ?? node.path
}

/** The table files among `nodes` whose rows are expanded, at any depth. */
export function expandedTableFiles(nodes: WorkspaceTreeNode[], expanded: ReadonlySet<string>): string[] {
  const found: string[] = []
  const visit = (items: WorkspaceTreeNode[]) => {
    for (const node of items) {
      if (node.virtual) continue
      if (node.type === 'file' && isTableFilePath(node.path) && expanded.has(treeDisclosureKey(node))) found.push(node.path)
      if (node.children.length) visit(node.children)
    }
  }
  visit(nodes)
  return found
}

function childNodes(file: KitTablesFile, parentPath: string): WorkspaceTreeNode[] {
  const child = (kind: TableFileChildKind, id: string, title: string): WorkspaceTreeNode => ({
    type: 'file',
    path: tableFileChildPath(file.path, kind, id),
    name: title,
    title,
    virtual: true,
    parentPath,
    children: [],
  })
  return [
    ...file.tables.map((table) => child('tables', table.id, table.title || table.name)),
    ...file.dashboards.map((dashboard) => child('dashboards', dashboard.id, dashboard.name)),
  ]
}

/** `nodes` with each described table file's tables and dashboards before its own child pages. */
export function withTableFileChildren(nodes: WorkspaceTreeNode[], files: Readonly<Record<string, KitTablesFile>>): WorkspaceTreeNode[] {
  if (!Object.keys(files).length) return nodes
  return nodes.map((node) => {
    const children = node.children.length ? withTableFileChildren(node.children, files) : node.children
    const file = node.type === 'file' && !node.virtual ? files[node.path] : undefined
    if (file) return { ...node, children: [...childNodes(file, node.path), ...children] }
    return children === node.children ? node : { ...node, children }
  })
}
