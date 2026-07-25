   
                 
  
                            
                              
                     
                                  
                            
  
                                                  
   

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/registry/ui/command'

import { useBookmarks } from '@/features/document/editor/hooks/useBookmarks'
import { usePinnedTabs } from '@/features/document/editor/hooks/usePinnedTabs'
import { useRecentFiles } from '@/features/document/editor/hooks/useRecentFiles'
import { vaultClient, type VaultTreeItem } from '@/features/document/editor/vault/vault-client'

function flatten(items: VaultTreeItem[], out: VaultTreeItem[] = []): VaultTreeItem[] {
  for (const item of items) {
    out.push(item)
    if (item.children?.length) flatten(item.children, out)
  }
  return out
}

function lastSegment(p: string): string {
  const idx = p.lastIndexOf('/')
  return idx >= 0 ? p.slice(idx + 1) : p
}

function stripMd(p: string): string {
  return p.replace(/\.md$/i, '')
}

type FileEntry = { path: string; base: string; folder: string }

export type DocumentQuickSwitcherProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
                            
  currentPath?: string
  onOpen: (path: string) => void
}

export function DocumentQuickSwitcher({
  open,
  onOpenChange,
  currentPath,
  onOpen,
}: DocumentQuickSwitcherProps) {
  const { t } = useTranslation('document')
  const [files, setFiles] = useState<FileEntry[] | null>(null)
  const [query, setQuery] = useState('')
  const bookmarks = useBookmarks()
  const pinned = usePinnedTabs()
  const recents = useRecentFiles()

  const bookmarkSet = useMemo(() => new Set(bookmarks.map((b) => b.path)), [bookmarks])
  const pinnedSet = useMemo(() => new Set(pinned), [pinned])
  const recentOrder = useMemo(() => {
    const m = new Map<string, number>()
    recents.forEach((r, i) => m.set(r.path, i))
    return m
  }, [recents])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void (async () => {
      try {
        const resp = await vaultClient.list()
        const items = flatten(resp.items).filter(
          (t) => t.type === 'file' && /\.md$/i.test(t.path),
        )
        const entries: FileEntry[] = items.map((t) => {
          const base = stripMd(lastSegment(t.path))
          const folder = t.path.includes('/') ? t.path.slice(0, t.path.lastIndexOf('/')) : ''
          return { path: t.path, base, folder }
        })
        if (!cancelled) setFiles(entries)
      } catch {
        if (!cancelled) setFiles([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open])

  const filtered = useMemo(() => {
    if (!files) return []
    const q = query.trim().toLowerCase()
    const scored = files
      .filter((f) => f.path !== currentPath)
      .map((f) => {
        let score = 0
        if (q) {
          const base = f.base.toLowerCase()
          const path = f.path.toLowerCase()
          if (base === q) score = 1000
          else if (base.startsWith(q)) score = 500
          else if (base.includes(q)) score = 300
          else if (path.includes(q)) score = 100
          else score = -1
        }
        if (score >= 0) {
          if (bookmarkSet.has(f.path)) score += 80
          if (pinnedSet.has(f.path)) score += 60
          const r = recentOrder.get(f.path)
          if (r != null) score += Math.max(0, 50 - r)
        }
        return { entry: f, score }
      })
      .filter((s) => s.score >= 0)
    scored.sort((a, b) => b.score - a.score || a.entry.path.localeCompare(b.entry.path))
    return scored.slice(0, 100).map((s) => s.entry)
  }, [files, query, currentPath, bookmarkSet, pinnedSet, recentOrder])

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput
        placeholder={t('command.quickSwitcher.placeholder')}
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>{files === null ? t('command.quickSwitcher.loading') : t('command.quickSwitcher.noMatches')}</CommandEmpty>
        {filtered.length > 0 ? (
          <CommandGroup heading={t('command.quickSwitcher.groupCount', { count: filtered.length })}>
            {filtered.map((f) => {
              const isBookmark = bookmarkSet.has(f.path)
              const isPinned = pinnedSet.has(f.path)
              const isRecent = recentOrder.has(f.path)
              return (
                <CommandItem
                  key={f.path}
                  value={f.path}
                  onSelect={() => {
                    onOpen(f.path)
                    onOpenChange(false)
                  }}
                  className="flex flex-col items-start gap-0.5"
                >
                  <div className="flex w-full items-center gap-1.5">
                    <span className="text-[13px] font-medium">{f.base}</span>
                    {isBookmark ? <span title={t('command.quickSwitcher.bookmarkTitle')}>⭐</span> : null}
                    {isPinned ? <span title={t('command.quickSwitcher.pinnedTitle')}>📌</span> : null}
                    {!isBookmark && !isPinned && isRecent ? <span title={t('command.quickSwitcher.recentTitle')} className="opacity-60">🕒</span> : null}
                  </div>
                  {f.folder ? (
                    <span className="text-[10.5px] text-muted-foreground">{f.folder}</span>
                  ) : null}
                </CommandItem>
              )
            })}
          </CommandGroup>
        ) : null}
      </CommandList>
    </CommandDialog>
  )
}
