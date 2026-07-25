   
                    
  
                                         
                         
   

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

type BlockEntry = {
  id: string
  lineNo: number
  pos: number
  preview: string
}

const BLOCK_RE = /\^([A-Za-z0-9_-]+)\s*$/

function collectBlocks(view: EditorView): BlockEntry[] {
  const doc = view.state.doc
  const out: BlockEntry[] = []
  let inFence = false
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i)
    const text = line.text
    if (/^\s*```/.test(text)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = BLOCK_RE.exec(text)
    if (!m) continue
    const preview = text.slice(0, m.index).trim().slice(0, 80)
    out.push({
      id: m[1],
      lineNo: i,
      pos: line.from,
      preview,
    })
  }
  return out
}

export type DocumentBlockJumpDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  getView: () => EditorView | null
}

export function DocumentBlockJumpDialog({
  open,
  onOpenChange,
  getView,
}: DocumentBlockJumpDialogProps) {
  const { t } = useTranslation('document')
  const [blocks, setBlocks] = useState<BlockEntry[]>([])
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (!open) {
      setQuery('')
      return
    }
    const view = getView()
    if (!view) {
      setBlocks([])
      return
    }
    setBlocks(collectBlocks(view))
  }, [open, getView])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return blocks
    return blocks.filter(
      (b) => b.id.toLowerCase().includes(q) || b.preview.toLowerCase().includes(q),
    )
  }, [blocks, query])

  const jump = (entry: BlockEntry) => {
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
        placeholder={t('command.block.placeholder')}
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>
          {blocks.length === 0 ? t('command.block.noBlocks') : t('command.block.noMatches')}
        </CommandEmpty>
        {filtered.length > 0 ? (
          <CommandGroup heading={t('command.block.groupCount', { count: filtered.length })}>
            {filtered.map((b) => (
              <CommandItem
                key={`${b.lineNo}-${b.id}`}
                value={`${b.id} ${b.preview}`}
                onSelect={() => jump(b)}
                className="flex items-center gap-2"
              >
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono">
                  ^{b.id}
                </span>
                <span className="flex-1 truncate text-[12px] text-muted-foreground">
                  {b.preview || t('command.block.emptyLine')}
                </span>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  L{b.lineNo}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
      </CommandList>
    </CommandDialog>
  )
}
