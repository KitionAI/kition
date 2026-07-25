   
                      
  
                                  
                                             
                         
  
                              
   

import { EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
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

export type OutlineHeading = {
  level: number
  text: string
  line: number // 1-based
}

export function extractOutlineHeadings(source: string): OutlineHeading[] {
  const headings: OutlineHeading[] = []
  const lines = source.split(/\r?\n/)
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]
    if (/^\s*```/.test(text)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(text)
    if (!m) continue
    headings.push({ level: m[1].length, text: m[2], line: i + 1 })
  }
  return headings
}

export type DocumentHeadingOutlineDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  source: string
  getView: () => EditorView | null
}

export function DocumentHeadingOutlineDialog({
  open,
  onOpenChange,
  source,
  getView,
}: DocumentHeadingOutlineDialogProps) {
  const { t } = useTranslation('document')
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  const headings = useMemo(() => (open ? extractOutlineHeadings(source) : []), [open, source])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return headings
    return headings.filter((h) => h.text.toLowerCase().includes(q))
  }, [headings, query])

                                   
  const minLevel = useMemo(() => {
    if (filtered.length === 0) return 1
    let min = 6
    for (const h of filtered) if (h.level < min) min = h.level
    return min
  }, [filtered])

  const jumpTo = (h: OutlineHeading) => {
    const view = getView()
    if (!view) {
      onOpenChange(false)
      return
    }
    onOpenChange(false)
    queueMicrotask(() => {
      const lineNo = Math.min(h.line, view.state.doc.lines)
      const line = view.state.doc.line(lineNo)
      view.dispatch({
        selection: EditorSelection.cursor(line.from),
        effects: EditorView.scrollIntoView(line.from, { y: 'start' }),
      })
      view.focus()
    })
  }

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput
        placeholder={t('command.heading.outlinePlaceholder', { count: headings.length })}
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>
          {headings.length === 0 ? t('command.heading.noHeadings') : t('command.heading.noMatches')}
        </CommandEmpty>
        {filtered.length > 0 ? (
          <CommandGroup heading={t('command.heading.outlineGroup')}>
            {filtered.map((h, idx) => {
              const depth = Math.max(0, h.level - minLevel)
              return (
                <CommandItem
                  key={`${h.line}-${idx}`}
                  value={`${'#'.repeat(h.level)} ${h.text}`}
                  onSelect={() => jumpTo(h)}
                  className="flex items-center gap-2"
                >
                  <span
                    className="truncate text-[13px]"
                    style={{ paddingLeft: `${depth * 12}px` }}
                  >
                    <span className="text-[10px] text-muted-foreground mr-1.5">H{h.level}</span>
                    {h.text}
                  </span>
                  <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">
                    L{h.line}
                  </span>
                </CommandItem>
              )
            })}
          </CommandGroup>
        ) : null}
      </CommandList>
    </CommandDialog>
  )
}
