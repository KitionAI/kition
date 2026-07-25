   
               
  
                                             
                             
   

import { Tag } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Input } from '@/registry/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/registry/ui/dialog'
import { readWorkspaceDocument, writeWorkspaceDocument } from '@/services/desktop'

import { parseTags } from '../lib/tag-parser'
import { loadVaultMarkdownFiles } from '../vault/vault-files'

const SCAN_LIMIT = 600

export type DocumentTagBrowserDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpen: (path: string) => void
}

type TagIndex = {
                     
  counts: Map<string, number>
                          
  files: Map<string, Set<string>>
                
  scanned: number
                               
  total: number
}

function basename(path: string): string {
  return path.split('/').pop() ?? path
}

export function DocumentTagBrowserDialog({
  open,
  onOpenChange,
  onOpen,
}: DocumentTagBrowserDialogProps) {
  const { t } = useTranslation('document')
  const [index, setIndex] = useState<TagIndex | null>(null)
  const [filter, setFilter] = useState('')
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const [renameTarget, setRenameTarget] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) {
      setActiveTag(null)
      setRenameTarget(null)
      setFilter('')
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const files = await loadVaultMarkdownFiles()
        if (cancelled) return
        const counts = new Map<string, number>()
        const filesIdx = new Map<string, Set<string>>()
        const limit = Math.min(files.length, SCAN_LIMIT)
        for (let i = 0; i < limit; i++) {
          if (cancelled) return
          try {
            const doc = await readWorkspaceDocument(files[i].path)
            const tags = parseTags(doc.content ?? '')
            for (const t of tags) {
              counts.set(t.name, (counts.get(t.name) ?? 0) + 1)
              if (!filesIdx.has(t.name)) filesIdx.set(t.name, new Set())
              filesIdx.get(t.name)!.add(files[i].path)
            }
          } catch {
            /* skip */
          }
        }
        if (cancelled) return
        setIndex({ counts, files: filesIdx, scanned: limit, total: files.length })
      } catch {
        if (!cancelled) setIndex({ counts: new Map(), files: new Map(), scanned: 0, total: 0 })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open])

  const sortedTags = useMemo(() => {
    if (!index) return []
    const q = filter.trim().toLowerCase()
    return Array.from(index.counts.entries())
      .filter(([name]) => !q || name.toLowerCase().includes(q))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }, [index, filter])

  const activeFiles = useMemo(() => {
    if (!index || !activeTag) return []
    return Array.from(index.files.get(activeTag) ?? []).sort()
  }, [index, activeTag])

  const renameAcrossVault = async (oldName: string, newName: string) => {
    if (!index) return
    if (!newName.trim() || newName === oldName) {
      setRenameTarget(null)
      return
    }
    setBusy(true)
    try {
      const paths = Array.from(index.files.get(oldName) ?? [])
      const tokenRegex = new RegExp(
        `(^|\\s)#${oldName.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}(?=$|[^\\p{L}\\p{N}_/-])`,
        'gmu',
      )
      for (const p of paths) {
        try {
          const doc = await readWorkspaceDocument(p)
          const orig = doc.content ?? ''
          const next = orig.replace(tokenRegex, (_m, lead) => `${lead}#${newName}`)
          if (next !== orig) await writeWorkspaceDocument(p, next)
        } catch {
          /* skip */
        }
      }
    } finally {
      setBusy(false)
      setRenameTarget(null)
      setActiveTag(null)
             
      setIndex(null)
      setTimeout(() => setIndex(null), 0)
      onOpenChange(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Tag className="size-4" />
            {t('dialog.tagBrowser.title')}
          </DialogTitle>
          <DialogDescription>
            {index
              ? t('dialog.tagBrowser.summary', { count: index.counts.size, scanned: index.scanned, total: index.total })
              : t('dialog.tagBrowser.scanning')}
          </DialogDescription>
        </DialogHeader>
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t('dialog.tagBrowser.filterPlaceholder')}
          className="h-8"
        />
        <div className="grid grid-cols-2 gap-2">
          <div className="max-h-80 space-y-0.5 overflow-auto pr-1">
            {sortedTags.length === 0 ? (
              <div className="px-1 py-4 text-center text-xs text-muted-foreground">
                {index ? t('dialog.tagBrowser.noTags') : t('dialog.tagBrowser.loading')}
              </div>
            ) : (
              sortedTags.map(([name, count]) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => setActiveTag(name)}
                  className={
                    'flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs '
                    + (activeTag === name ? 'bg-accent/60' : 'hover:bg-accent/40')
                  }
                >
                  <span className="font-mono">#{name}</span>
                  <span className="text-muted-foreground">{count}</span>
                </button>
              ))
            )}
          </div>
          <div className="max-h-80 overflow-auto border-l border-border/40 pl-2">
            {!activeTag ? (
              <div className="px-1 py-4 text-center text-xs text-muted-foreground">
                {t('dialog.tagBrowser.pickPrompt')}
              </div>
            ) : (
              <>
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-mono">#{activeTag}</span>
                  <button
                    type="button"
                    onClick={() => {
                      setRenameTarget(activeTag)
                      setRenameValue(activeTag)
                    }}
                    className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent/40"
                  >
                    {t('dialog.tagBrowser.renameAction')}
                  </button>
                </div>
                {activeFiles.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => {
                      onOpenChange(false)
                      onOpen(p)
                    }}
                    className="block w-full truncate rounded px-1.5 py-1 text-left text-[11px] hover:bg-accent/40"
                    title={p}
                  >
                    {basename(p)}
                  </button>
                ))}
              </>
            )}
          </div>
        </div>
        {renameTarget ? (
          <div className="rounded border border-border/40 bg-muted/20 p-2">
            <div className="mb-1 text-xs text-muted-foreground">
              {t('dialog.tagBrowser.renamePrompt', { old: `#${renameTarget}` })}
            </div>
            <div className="flex gap-2">
              <Input
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                className="h-7"
              />
              <button
                type="button"
                onClick={() => void renameAcrossVault(renameTarget, renameValue.trim())}
                disabled={busy}
                className="rounded bg-primary px-3 text-xs text-primary-foreground disabled:opacity-50"
              >
                {busy ? t('dialog.tagBrowser.renaming') : t('dialog.tagBrowser.renameApply')}
              </button>
              <button
                type="button"
                onClick={() => setRenameTarget(null)}
                className="rounded px-3 text-xs text-muted-foreground hover:bg-accent/40"
              >
                {t('dialog.tagBrowser.renameCancel')}
              </button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
