   
               
  
                                  
   

import { Star, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { useBookmarks, useBookmarksActions } from '@/features/document/editor/hooks/useBookmarks'
import { cn } from '@/lib/utils'

function lastSegment(p: string): string {
  const idx = p.lastIndexOf('/')
  return idx >= 0 ? p.slice(idx + 1) : p
}

function stripMd(p: string): string {
  return p.replace(/\.md$/i, '')
}

function parentDir(p: string): string {
  const idx = p.lastIndexOf('/')
  return idx > 0 ? p.slice(0, idx) : ''
}

export type DocumentBookmarksPanelProps = {
  currentPath?: string
  onOpen: (path: string) => void
  className?: string
}

export function DocumentBookmarksPanel({ currentPath, onOpen, className }: DocumentBookmarksPanelProps) {
  const { t } = useTranslation('document')
  const items = useBookmarks()
  const { remove } = useBookmarksActions()

  if (items.length === 0) {
    return (
      <div className={cn('document-bookmarks-empty p-3 text-xs text-muted-foreground', className)}>
        {t('panels.bookmarks.empty')}
        <div className="mt-1 text-[10.5px] opacity-70">{t('panels.bookmarks.emptyHint')}</div>
      </div>
    )
  }

  return (
    <div className={cn('document-bookmarks flex flex-col gap-1 p-2 text-sm', className)}>
      <div className="px-1 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {t('panels.bookmarks.summary', { count: items.length })}
      </div>
      {items.map((it) => {
        const isCurrent = it.path === currentPath
        const dir = parentDir(it.path)
        return (
          <div
            key={it.path}
            className={cn(
              'group flex items-center gap-1 rounded px-2 py-1 transition',
              isCurrent ? 'bg-accent/40 text-foreground' : 'hover:bg-accent/40 hover:text-foreground',
            )}
            title={it.path}
          >
            <Star className="size-3.5 shrink-0 text-yellow-500" />
            <button
              type="button"
              onClick={() => onOpen(it.path)}
              disabled={isCurrent}
              className="flex min-w-0 flex-1 flex-col items-start gap-0 text-left"
            >
              <span className="truncate text-[12.5px] font-medium">
                {it.alias || stripMd(lastSegment(it.path))}
              </span>
              {dir ? (
                <span className="truncate text-[10.5px] text-muted-foreground">
                  {dir}
                </span>
              ) : null}
            </button>
            <button
              type="button"
              onClick={() => remove(it.path)}
              className="hidden rounded p-0.5 text-muted-foreground hover:bg-destructive/20 hover:text-destructive group-hover:block"
              title={t('panels.bookmarks.remove')}
            >
              <X className="size-3" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
