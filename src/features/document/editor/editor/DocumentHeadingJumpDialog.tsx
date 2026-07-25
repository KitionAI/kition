   
                   
  
                               
                         
                                            
                    
                                
   

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

type HeadingEntry = {
  level: number
  text: string
  lineNo: number
  pos: number
}

const HEADING_LINE_RE = /^\s*(#{1,6})\s+(.+?)\s*$/

function collectHeadings(view: EditorView): HeadingEntry[] {
  const doc = view.state.doc
  const out: HeadingEntry[] = []
  let inFence = false
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i)
    const text = line.text
    if (/^\s*```/.test(text)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = HEADING_LINE_RE.exec(text)
    if (!m) continue
    out.push({
      level: m[1].length,
      text: m[2],
      lineNo: i,
      pos: line.from + m[0].indexOf('#'),
    })
  }
  return out
}

export type DocumentHeadingJumpDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  getView: () => EditorView | null
}

export function DocumentHeadingJumpDialog({
  open,
  onOpenChange,
  getView,
}: DocumentHeadingJumpDialogProps) {
  const { t } = useTranslation('document')
  const [headings, setHeadings] = useState<HeadingEntry[]>([])
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (!open) {
      setQuery('')
      return
    }
    const view = getView()
    if (!view) {
      setHeadings([])
      return
    }
    setHeadings(collectHeadings(view))
  }, [open, getView])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return headings
    return headings.filter((h) => h.text.toLowerCase().includes(q))
  }, [headings, query])

  const jump = (entry: HeadingEntry) => {
    const view = getView()
    if (!view) {
      onOpenChange(false)
      return
    }
    onOpenChange(false)
    queueMicrotask(() => {
      view.dispatch({
        selection: EditorSelection.cursor(entry.pos),
        effects: EditorView.scrollIntoView(entry.pos, { y: 'start', yMargin: 60 }),
      })
      view.focus()
    })
  }

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput
        placeholder={t('command.heading.placeholder')}
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>
          {headings.length === 0 ? t('command.heading.noHeadings') : t('command.heading.noMatches')}
        </CommandEmpty>
        {filtered.length > 0 ? (
          <CommandGroup heading={t('command.heading.groupCount', { count: filtered.length })}>
            {filtered.map((h) => (
              <CommandItem
                key={`${h.lineNo}-${h.text}`}
                value={`${h.text} ${h.lineNo}`}
                onSelect={() => jump(h)}
                className="flex items-center gap-2"
              >
                <span
                  className="inline-block shrink-0 text-[10px] text-muted-foreground"
                  style={{ paddingLeft: (h.level - 1) * 12 }}
                >
                  H{h.level}
                </span>
                <span className="flex-1 truncate text-[13px]">{h.text}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  L{h.lineNo}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
      </CommandList>
    </CommandDialog>
  )
}
