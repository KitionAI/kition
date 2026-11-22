import type { KitsOutlineItem } from '@/api/kits'
import { hasWorkspaceOutline } from '@/services/workspaceFormats'
import type { WorkspaceTreeNode } from '@/features/workspace/lib/workspace'

/**
 * The parts of a kit's file as its children in the workspace tree. A kit whose manifest names an
 * outline command (`kit.json` `outline`, platform K24) answers what a file holds (through the
 * runtime's `/v1/kits/outline`): a table file's tables and dashboards, a deck's slides. A child
 * opens the file in its kit at that part, by the Kit UI `view` the kit gave for it
 * (`document.view`, `document/reveal`). Kition does not know what a part is.
 */
const KIT_PART_PREFIX = 'kit-part://'

/** The tree path of a part of a file: `kit-part://<id>/<view as JSON>/<file path>`, the first two percent-encoded. */
export function kitPartPath(filePath: string, item: Pick<KitsOutlineItem, 'id' | 'view'>) {
  return `${KIT_PART_PREFIX}${encodeURIComponent(item.id)}/${encodeURIComponent(JSON.stringify(item.view))}/${filePath}`
}

/** The file and the view a part's tree path names; null for any other path. */
export function parseKitPartPath(path: string): { filePath: string; id: string; view: Record<string, unknown> } | null {
  if (!path.startsWith(KIT_PART_PREFIX)) return null
  const match = /^([^/]*)\/([^/]*)\/(.+)$/.exec(path.slice(KIT_PART_PREFIX.length))
  if (!match) return null
  try {
    const view: unknown = JSON.parse(decodeURIComponent(match[2]))
    if (!view || typeof view !== 'object' || Array.isArray(view)) return null
    return { filePath: match[3], id: decodeURIComponent(match[1]), view: view as Record<string, unknown> }
  } catch {
    return null
  }
}

/** The disclosure key of a tree node: a file with child pages expands under its folder's path. */
function treeDisclosureKey(node: WorkspaceTreeNode) {
  return node.folderPath ?? node.path
}

/** The files among `nodes` whose kit has an outline and whose rows are expanded, at any depth. */
export function expandedOutlineFiles(nodes: WorkspaceTreeNode[], expanded: ReadonlySet<string>): string[] {
  const found: string[] = []
  const visit = (items: WorkspaceTreeNode[]) => {
    for (const node of items) {
      if (node.virtual) continue
      if (node.type === 'file' && hasWorkspaceOutline(node.path) && expanded.has(treeDisclosureKey(node))) found.push(node.path)
      if (node.children.length) visit(node.children)
    }
  }
  visit(nodes)
  return found
}

function childNodes(filePath: string, items: readonly KitsOutlineItem[]): WorkspaceTreeNode[] {
  return items.map((item) => ({
    type: 'file',
    path: kitPartPath(filePath, item),
    name: item.title,
    title: item.title,
    virtual: true,
    parentPath: filePath,
    children: [],
  }))
}

/** `nodes` with each file's outline, as read, before its own child pages. */
export function withOutlineChildren(nodes: WorkspaceTreeNode[], outlines: Readonly<Record<string, readonly KitsOutlineItem[]>>): WorkspaceTreeNode[] {
  if (!Object.keys(outlines).length) return nodes
  return nodes.map((node) => {
    const children = node.children.length ? withOutlineChildren(node.children, outlines) : node.children
    const outline = node.type === 'file' && !node.virtual ? outlines[node.path] : undefined
    if (outline) return { ...node, children: [...childNodes(node.path, outline), ...children] }
    return children === node.children ? node : { ...node, children }
  })
}
