   
                      
  
                               
                                            
                
   

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/registry/ui/command'

import { vaultClient, type VaultTreeItem } from '@/features/document/editor/vault/vault-client'
import { readWorkspaceDocument } from '@/services/desktop'

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

type Hit = {
  path: string
  base: string
  line: number
  text: string
}

const MAX_FILES = 400
const MAX_HITS_PER_FILE = 5
const MAX_TOTAL_HITS = 200

export type DocumentGlobalSearchProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpen: (path: string, line: number) => void
}

export function DocumentGlobalSearch({ open, onOpenChange, onOpen }: DocumentGlobalSearchProps) {
  const { t } = useTranslation('document')
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<Hit[]>([])
  const [scanning, setScanning] = useState(false)
  const filesRef = useRef<VaultTreeItem[] | null>(null)
  const contentRef = useRef<Map<string, string>>(new Map())
  const runRef = useRef(0)

  const ensureFiles = useCallback(async (): Promise<VaultTreeItem[]> => {
    if (filesRef.current) return filesRef.current
    const resp = await vaultClient.list()
    filesRef.current = flatten(resp.items).filter(
      (t) => t.type === 'file' && /\.md$/i.test(t.path),
    )
    return filesRef.current
  }, [])

  useEffect(() => {
    if (!open) {
      setQuery('')
      setHits([])
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const q = query.trim()
    if (q.length < 2) {
      setHits([])
      setScanning(false)
      return
    }
    const runId = ++runRef.current
    setScanning(true)
    setHits([])
    const qLower = q.toLowerCase()
    const found: Hit[] = []
    void (async () => {
      const files = await ensureFiles()
      const limit = Math.min(files.length, MAX_FILES)
      for (let i = 0; i < limit; i++) {
        if (runId !== runRef.current) return
        const file = files[i]
        let content = contentRef.current.get(file.path)
        if (content == null) {
          try {
            const doc = await readWorkspaceDocument(file.path)
            content = doc.content ?? ''
            contentRef.current.set(file.path, content)
          } catch {
            continue
          }
        }
        if (content.toLowerCase().indexOf(qLower) === -1) continue
        const lines = content.split(/\r?\n/)
        let perFile = 0
        for (let li = 0; li < lines.length && perFile < MAX_HITS_PER_FILE; li++) {
          const lower = lines[li].toLowerCase()
          if (lower.indexOf(qLower) === -1) continue
          found.push({
            path: file.path,
            base: stripMd(lastSegment(file.path)),
            line: li + 1,
            text: lines[li].trim().slice(0, 200),
          })
          perFile += 1
          if (found.length >= MAX_TOTAL_HITS) break
        }
        if (i % 8 === 0 && runId === runRef.current) {
          setHits([...found])
        }
        if (found.length >= MAX_TOTAL_HITS) break
      }
      if (runId === runRef.current) {
        setHits([...found])
        setScanning(false)
      }
    })()
  }, [query, open, ensureFiles])

  // Group hits by file path
  const groups: { path: string; base: string; hits: Hit[] }[] = []
  let lastPath: string | null = null
  for (const h of hits) {
    if (h.path !== lastPath) {
      groups.push({ path: h.path, base: h.base, hits: [] })
      lastPath = h.path
    }
    groups[groups.length - 1].hits.push(h)
  }

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput
        placeholder={t('command.globalSearch.placeholder')}
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>
          {query.trim().length < 2
            ? t('command.globalSearch.keepTyping')
            : scanning
              ? t('command.globalSearch.searching')
              : t('command.globalSearch.noMatches')}
        </CommandEmpty>
        {groups.map((g) => (
          <CommandGroup key={g.path} heading={t('command.globalSearch.groupResults', { base: g.base, count: g.hits.length })}>
            {g.hits.map((h) => (
              <CommandItem
                key={`${h.path}:${h.line}`}
                value={`${h.path}:${h.line}:${h.text}`}
                onSelect={() => {
                  onOpen(h.path, h.line)
                  onOpenChange(false)
                }}
                className="flex flex-col items-start gap-0.5"
              >
                <span className="text-[11px] text-muted-foreground">{t('command.globalSearch.linePrefix', { line: h.line })}</span>
                <span className="line-clamp-2 text-[12.5px]">{h.text || t('command.globalSearch.emptyLine')}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
        {scanning && groups.length > 0 ? (
          <div className="px-3 py-2 text-[11px] text-muted-foreground">{t('command.globalSearch.stillScanning')}</div>
        ) : null}
      </CommandList>
    </CommandDialog>
  )
}
