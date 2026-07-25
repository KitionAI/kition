   
                  
  
                                               
                                          
   

import { useTranslation } from 'react-i18next'

import { useRecentFiles } from '@/features/document/editor/hooks/useRecentFiles'
import { getCurrentLocale } from '@/i18n'
import { cn } from '@/lib/utils'

function lastSegment(p: string): string {
  const idx = p.lastIndexOf('/')
  return idx >= 0 ? p.slice(idx + 1) : p
}

function stripMd(p: string): string {
  return p.replace(/\.md$/i, '')
}

function useRelative(): (time: string) => string {
  const { t } = useTranslation('document')
  return (time: string) => {
    const ts = new Date(time).getTime()
    if (Number.isNaN(ts)) return ''
    const diff = Date.now() - ts
    const minute = 60_000
    const hour = 60 * minute
    const day = 24 * hour
    if (diff < minute) return t('panels.recents.justNow')
    if (diff < hour) return t('panels.recents.minutesAgo', { count: Math.floor(diff / minute) })
    if (diff < day) return t('panels.recents.hoursAgo', { count: Math.floor(diff / hour) })
    if (diff < 30 * day) return t('panels.recents.daysAgo', { count: Math.floor(diff / day) })
    return new Date(time).toLocaleDateString(getCurrentLocale())
  }
}

export type DocumentRecentsPanelProps = {
  currentPath?: string
  onOpen: (path: string) => void
  className?: string
}

export function DocumentRecentsPanel({ currentPath, onOpen, className }: DocumentRecentsPanelProps) {
  const { t } = useTranslation('document')
  const items = useRecentFiles()
  const relative = useRelative()

  if (items.length === 0) {
    return (
      <div className={cn('document-recents-empty p-3 text-xs text-muted-foreground', className)}>
        {t('panels.recents.empty')}
      </div>
    )
  }

  return (
    <div className={cn('document-recents flex flex-col gap-1 p-2 text-sm', className)}>
      <div className="px-1 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {t('panels.recents.summary', { count: items.length })}
      </div>
      {items.map((it) => {
        const isCurrent = it.path === currentPath
        return (
          <button
            key={it.path}
            type="button"
            onClick={() => onOpen(it.path)}
            disabled={isCurrent}
            className={cn(
              'flex flex-col items-start gap-0.5 rounded px-2 py-1 text-left transition',
              isCurrent
                ? 'bg-accent/40 text-foreground'
                : 'hover:bg-accent/40 hover:text-foreground',
            )}
            title={it.path}
          >
            <span className="text-[12.5px] font-medium">{stripMd(lastSegment(it.path))}</span>
            <span className="text-[10.5px] text-muted-foreground">
              {relative(it.visitedAt)}{isCurrent ? ` · ${t('panels.recents.current')}` : ''}
            </span>
          </button>
        )
      })}
    </div>
  )
}
