   
                        
  
                                           
                
  
                                                           
   

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

export type DocumentTagEntry = {
  tag: string            
  count: number
  firstLine: number
  firstCol: number
}

export function extractDocumentTags(source: string): DocumentTagEntry[] {
  const counts = new Map<string, { count: number; firstLine: number; firstCol: number }>()
  const lines = source.split(/\r?\n/)
  let inFence = false
  for (let li = 0; li < lines.length; li++) {
    const text = lines[li]
    if (/^\s*```/.test(text)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
                                         
    const cleaned = text.replace(/`[^`]*`/g, (m) => ' '.repeat(m.length))
    const re = /(^|[\s\p{P}])#([\p{L}\p{N}_/\-]+)/gu
    let m: RegExpExecArray | null
    while ((m = re.exec(cleaned)) !== null) {
      const lead = m[1]
      const tagBody = m[2]
                                                               
                                 
      if (/^\d/.test(tagBody)) continue
      const tag = '#' + tagBody
      const startCol = m.index + lead.length + 1 // 1-based col of `#`
      const existing = counts.get(tag)
      if (existing) {
        existing.count += 1
      } else {
        counts.set(tag, { count: 1, firstLine: li + 1, firstCol: startCol })
      }
    }
  }
  return Array.from(counts.entries())
    .map(([tag, v]) => ({ tag, count: v.count, firstLine: v.firstLine, firstCol: v.firstCol }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
}

export type DocumentTagsDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  source: string
  getView: () => EditorView | null
}

export function DocumentTagsDialog({
  open,
  onOpenChange,
  source,
  getView,
}: DocumentTagsDialogProps) {
  const { t } = useTranslation('document')
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  const entries = useMemo(() => (open ? extractDocumentTags(source) : []), [open, source])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return entries
    return entries.filter((e) => e.tag.toLowerCase().includes(q))
  }, [entries, query])

  const jumpTo = (entry: DocumentTagEntry) => {
    const view = getView()
    if (!view) {
      onOpenChange(false)
      return
    }
    onOpenChange(false)
    queueMicrotask(() => {
      const line = view.state.doc.line(Math.min(entry.firstLine, view.state.doc.lines))
      const pos = line.from + Math.min(entry.firstCol - 1, line.length)
      view.dispatch({
        selection: EditorSelection.cursor(pos),
        effects: EditorView.scrollIntoView(pos, { y: 'center' }),
      })
      view.focus()
    })
  }

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput
        placeholder={t('command.documentTags.placeholder', { count: entries.length })}
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>
          {entries.length === 0 ? t('command.documentTags.noTags') : t('command.documentTags.noMatches')}
        </CommandEmpty>
        {filtered.length > 0 ? (
          <CommandGroup heading={t('command.documentTags.groupCount', { count: filtered.length })}>
            {filtered.map((e) => (
              <CommandItem
                key={e.tag}
                value={`${e.tag} ${e.count}`}
                onSelect={() => jumpTo(e)}
                className="flex items-center gap-2"
              >
                <span className="flex-1 truncate text-[13px]">{e.tag}</span>
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  L{e.firstLine}
                </span>
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                  {e.count}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
      </CommandList>
    </CommandDialog>
  )
}
