   
                   
  
                         
   

import { Pin, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'

import { unpinTab, usePinnedTabs } from '../hooks/usePinnedTabs'

export type DocumentPinnedTabBarProps = {
  currentPath?: string | null
  onOpen: (path: string) => void
}

function basename(path: string): string {
  const seg = path.split('/').pop() ?? path
  return seg.replace(/\.md$/i, '')
}

export function DocumentPinnedTabBar({ currentPath, onOpen }: DocumentPinnedTabBarProps) {
  const { t } = useTranslation('document')
  const tabs = usePinnedTabs()
  if (tabs.length === 0) return null
  return (
    <div className="document-editor-tabs flex items-center gap-0.5 overflow-x-auto border-b border-border/40 px-1 py-0.5 text-[11px]">
      <Pin className="mx-1 size-3 shrink-0 text-muted-foreground/60" />
      {tabs.map((p) => {
        const active = p === currentPath
        return (
          <div
            key={p}
            className={cn(
              'group flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 transition',
              active ? 'bg-accent/60 text-foreground' : 'text-muted-foreground hover:bg-accent/30 hover:text-foreground',
            )}
          >
            <button
              type="button"
              onClick={() => onOpen(p)}
              className="max-w-[150px] truncate"
              title={p}
            >
              {basename(p)}
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                unpinTab(p)
              }}
              className="opacity-0 transition group-hover:opacity-100 hover:text-destructive"
              title={t('pinnedTabs.unpin')}
            >
              <X className="size-3" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
