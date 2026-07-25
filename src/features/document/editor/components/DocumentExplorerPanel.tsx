   
                
  
                                           
                                                
   

import { ChevronDown, ChevronRight, File as FileIcon, Folder, FolderOpen } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { vaultClient, type VaultTreeItem } from '@/features/document/editor/vault/vault-client'
import { cn } from '@/lib/utils'

export type DocumentExplorerPanelProps = {
  currentPath?: string
  onOpen: (path: string) => void
  className?: string
}

function sortTree(items: VaultTreeItem[]): VaultTreeItem[] {
  const folders = items.filter((i) => i.type === 'folder')
  const files = items.filter((i) => i.type === 'file')
  folders.sort((a, b) => a.name.localeCompare(b.name))
  files.sort((a, b) => a.name.localeCompare(b.name))
  return [
    ...folders.map((f) => ({ ...f, children: f.children ? sortTree(f.children) : undefined })),
    ...files,
  ]
}

function parentDirs(path: string): string[] {
  const parts = path.split('/').filter(Boolean)
  parts.pop()         
  const dirs: string[] = []
  let acc = ''
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p
    dirs.push(acc)
  }
  return dirs
}

export function DocumentExplorerPanel({ currentPath, onOpen, className }: DocumentExplorerPanelProps) {
  const { t } = useTranslation('document')
  const [tree, setTree] = useState<VaultTreeItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const initialAutoExpand = useRef(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const resp = await vaultClient.list()
        if (cancelled) return
        setTree(sortTree(resp.items))
      } catch (e) {
        if (cancelled) return
        setError(String((e as Error)?.message ?? e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

                  
  useEffect(() => {
    if (!currentPath || initialAutoExpand.current) return
    const dirs = parentDirs(currentPath)
    if (dirs.length === 0) return
    setExpanded((prev) => {
      const next = new Set(prev)
      for (const d of dirs) next.add(d)
      return next
    })
    initialAutoExpand.current = true
  }, [currentPath])

  const handleToggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  if (error) {
    return (
      <div className={cn('p-3 text-xs text-destructive', className)}>
        {t('panels.explorer.loadFailed', { error })}
      </div>
    )
  }

  if (!tree) {
    return (
      <div className={cn('p-3 text-xs text-muted-foreground', className)}>
        {t('panels.explorer.loading')}
      </div>
    )
  }

  return (
    <div className={cn('document-explorer p-1 text-sm', className)}>
      <Tree
        items={tree}
        depth={0}
        expanded={expanded}
        onToggle={handleToggle}
        currentPath={currentPath}
        onOpen={onOpen}
      />
    </div>
  )
}

function Tree({
  items,
  depth,
  expanded,
  onToggle,
  currentPath,
  onOpen,
}: {
  items: VaultTreeItem[]
  depth: number
  expanded: Set<string>
  onToggle: (path: string) => void
  currentPath?: string
  onOpen: (path: string) => void
}) {
  return (
    <ul className="flex flex-col">
      {items.map((item) => {
        const isFolder = item.type === 'folder'
        const isOpen = expanded.has(item.path)
        const isCurrent = !isFolder && item.path === currentPath
        return (
          <li key={item.path} className="leading-tight">
            <button
              type="button"
              onClick={() => (isFolder ? onToggle(item.path) : onOpen(item.path))}
              className={cn(
                'flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-[12.5px] transition hover:bg-accent/40 hover:text-foreground',
                isCurrent && 'bg-accent/40 text-foreground',
              )}
              style={{ paddingLeft: 4 + depth * 10 }}
              title={item.path}
            >
              {isFolder ? (
                isOpen ? (
                  <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
                )
              ) : (
                <span className="size-3 shrink-0" />
              )}
              {isFolder ? (
                isOpen ? (
                  <FolderOpen className="size-3.5 shrink-0 text-amber-500/80" />
                ) : (
                  <Folder className="size-3.5 shrink-0 text-amber-500/80" />
                )
              ) : (
                <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate">{item.name.replace(/\.md$/i, '')}</span>
            </button>
            {isFolder && isOpen && item.children?.length ? (
              <Tree
                items={item.children}
                depth={depth + 1}
                expanded={expanded}
                onToggle={onToggle}
                currentPath={currentPath}
                onOpen={onOpen}
              />
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}
