   
                     
  
                                           
                            
  
      
                   
                                        
                                 
                            
                        
                                       
   

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

const codePointText = (...values: number[]) => String.fromCodePoint(...values)
const cjkStopwords = [
  codePointText(0x7684), codePointText(0x4e86), codePointText(0x548c),
  codePointText(0x662f), codePointText(0x5728), codePointText(0x6211),
  codePointText(0x6709), codePointText(0x4e0d), codePointText(0x8fd9),
  codePointText(0x4e5f), codePointText(0x5c31), codePointText(0x4eba),
  codePointText(0x90fd), codePointText(0x4e00), codePointText(0x4e00, 0x4e2a),
]

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'as', 'if', 'so', 'that', 'this',
  'these', 'those', 'it', 'its', 'we', 'us', 'our', 'they', 'them', 'their', 'he', 'she', 'his',
  'her', 'you', 'your', 'i', 'me', 'my', 'do', 'does', 'did', 'has', 'have', 'had', 'will',
  'would', 'can', 'could', 'should', 'shall', 'may', 'might', 'no', 'not', 'too', 'very', 'just',
  'than', 'then', 'there', 'here', 'about', 'into', 'over', 'up', 'down', 'out',
  ...cjkStopwords,
])

export type WordFreqEntry = {
  token: string
  count: number
  firstLine: number
  firstCol: number
}

export function computeWordFrequency(source: string, minLen = 2): WordFreqEntry[] {
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
    const tokenRe = /#[\p{L}\p{N}_/-]+|[A-Za-z0-9]+(?:[’'][A-Za-z0-9]+)*|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu
    let m: RegExpExecArray | null
    while ((m = tokenRe.exec(text)) !== null) {
      const raw = m[0]
      const lower = raw.toLowerCase()
                            
      const isTag = raw.startsWith('#')
      const isCjk = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u.test(raw)
      if (!isTag && !isCjk) {
        if (lower.length < minLen) continue
        if (/^\d+$/.test(lower)) continue
      }
      if (STOPWORDS.has(lower)) continue
      const key = isTag ? raw : isCjk ? raw : lower
      const existing = counts.get(key)
      if (existing) {
        existing.count += 1
      } else {
        counts.set(key, { count: 1, firstLine: li + 1, firstCol: m.index + 1 })
      }
    }
  }
  return Array.from(counts.entries())
    .map(([token, v]) => ({ token, count: v.count, firstLine: v.firstLine, firstCol: v.firstCol }))
    .sort((a, b) => b.count - a.count || a.token.localeCompare(b.token))
}

export type DocumentWordFrequencyDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  source: string
  getView: () => EditorView | null
}

export function DocumentWordFrequencyDialog({
  open,
  onOpenChange,
  source,
  getView,
}: DocumentWordFrequencyDialogProps) {
  const { t } = useTranslation('document')
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  const entries = useMemo(() => (open ? computeWordFrequency(source) : []), [open, source])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return entries.slice(0, 200)
    return entries.filter((e) => e.token.toLowerCase().includes(q)).slice(0, 200)
  }, [entries, query])

  const jumpTo = (entry: WordFreqEntry) => {
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
        placeholder={t('command.wordFreq.placeholder', { count: entries.length })}
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>
          {entries.length === 0 ? t('command.wordFreq.noContent') : t('command.wordFreq.noMatches')}
        </CommandEmpty>
        {filtered.length > 0 ? (
          <CommandGroup heading={t('command.wordFreq.groupHeading', { count: filtered.length })}>
            {filtered.map((e) => (
              <CommandItem
                key={e.token}
                value={`${e.token} ${e.count}`}
                onSelect={() => jumpTo(e)}
                className="flex items-center gap-2"
              >
                <span className="flex-1 truncate text-[13px]">{e.token}</span>
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
