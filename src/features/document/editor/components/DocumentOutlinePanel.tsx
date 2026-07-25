   
                         
  
                                           
                              
   

import { useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'

export type OutlineHeading = {
  level: number
  text: string
  line: number
                                 
  depth: number
}

export function parseOutlineHeadings(source: string): OutlineHeading[] {
  if (!source) return []
  const lines = source.split(/\r?\n/)
  const headings: OutlineHeading[] = []
  let inFence = false
  let fenceMarker: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const trimmed = raw.trim()
                   
    if (!inFence && /^(```|~~~)/.test(trimmed)) {
      inFence = true
      fenceMarker = trimmed.startsWith('```') ? '```' : '~~~'
      continue
    }
    if (inFence && fenceMarker && trimmed.startsWith(fenceMarker)) {
      inFence = false
      fenceMarker = null
      continue
    }
    if (inFence) continue
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(raw)
    if (!m) continue
    headings.push({
      level: m[1].length,
      text: m[2].trim(),
      line: i + 1,
      depth: 0,
    })
  }
                  
  if (headings.length === 0) return []
  const minLevel = Math.min(...headings.map((h) => h.level))
  for (const h of headings) {
    h.depth = h.level - minLevel
  }
  return headings
}

export type DocumentOutlinePanelProps = {
  source: string
                               
  currentLine?: number | null
  onSelect?: (line: number) => void
  className?: string
}

export function DocumentOutlinePanel({
  source,
  currentLine,
  onSelect,
  className,
}: DocumentOutlinePanelProps) {
  const { t } = useTranslation('document')
  const allHeadings = useMemo(() => parseOutlineHeadings(source), [source])
  const [maxLevel, setMaxLevel] = useState(6)
  const [filter, setFilter] = useState('')
  const headings = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return allHeadings.filter((h) => {
      if (h.level > maxLevel) return false
      if (q && !h.text.toLowerCase().includes(q)) return false
      return true
    })
  }, [allHeadings, maxLevel, filter])

  const activeIndex = useMemo(() => {
    if (!currentLine || headings.length === 0) return -1
    let last = -1
    for (let i = 0; i < headings.length; i++) {
      if (headings[i].line <= currentLine) last = i
    }
    return last
  }, [currentLine, headings])

  if (allHeadings.length === 0) {
    return (
      <div className={cn('document-outline-empty p-3 text-xs text-muted-foreground', className)}>
        {t('panels.outline.empty')}
      </div>
    )
  }

  return (
    <div className={cn('document-outline flex h-full flex-col', className)}>
      <div className="flex shrink-0 items-center gap-1 border-b border-border/40 px-2 py-1 text-[10.5px] text-muted-foreground">
        <span>{t('panels.outline.showUpTo')}</span>
        {[1, 2, 3, 4, 5, 6].map((lvl) => (
          <button
            key={lvl}
            type="button"
            onClick={() => setMaxLevel(lvl)}
            className={cn(
              'rounded px-1.5 py-0.5 transition hover:bg-accent/40 hover:text-foreground',
              maxLevel === lvl && 'bg-accent/60 text-foreground',
            )}
            title={t('panels.outline.showUpToTitle', { lvl })}
          >
            H{lvl}
          </button>
        ))}
      </div>
      <div className="shrink-0 border-b border-border/40 px-2 py-1">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t('panels.outline.filterPlaceholder')}
          className="w-full rounded border border-border/40 bg-background px-2 py-0.5 text-[11.5px] outline-none focus:ring-1 focus:ring-ring"
        />
      </div>
      <nav
        className="flex flex-col gap-0.5 overflow-y-auto p-2 text-sm"
        aria-label={t('panels.outline.ariaLabel')}
      >
        {headings.length === 0 ? (
          <div className="px-2 py-2 text-[11.5px] text-muted-foreground">{t('panels.outline.noMatches')}</div>
        ) : (
          headings.map((h, idx) => (
            <button
              key={`${h.line}-${idx}`}
              type="button"
              onClick={() => onSelect?.(h.line)}
              className={cn(
                'document-outline-item flex w-full items-center gap-1 rounded px-2 py-1 text-left transition hover:bg-accent/40',
                idx === activeIndex && 'bg-accent/60 font-medium text-foreground',
              )}
              style={{ paddingLeft: `${0.5 + h.depth * 0.85}rem` }}
              title={t('panels.outline.itemTitle', { level: h.level, line: h.line })}
            >
              <ChevronRight className="size-3 shrink-0 opacity-50" />
              <span className="truncate text-[13px]">{h.text}</span>
            </button>
          ))
        )}
      </nav>
    </div>
  )
}
