   
               
  
                                                  
                       
   

import { AlertTriangle, FilePlus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/registry/ui/dialog'
import { notify } from '@/lib/notify'
import { readWorkspaceDocument, writeWorkspaceDocument } from '@/services/desktop'

import { parseWikilinks } from '../lib/wikilink-parser'
import { clearVaultFileCache, loadVaultMarkdownFiles } from '../vault/vault-files'

const SCAN_LIMIT = 600

export type DocumentBrokenLinksDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpen: (path: string, line?: number) => void
}

type BrokenRef = {
  target: string
  line: number
  raw: string
}

type Group = {
  path: string
  refs: BrokenRef[]
}

function basename(path: string): string {
  const seg = path.split('/').pop() ?? path
  return seg.replace(/\.md$/i, '')
}

function lowercased(s: string): string {
  return s.toLowerCase()
}

export function DocumentBrokenLinksDialog({
  open,
  onOpenChange,
  onOpen,
}: DocumentBrokenLinksDialogProps) {
  const { t } = useTranslation('errors')
  const { t: td } = useTranslation('document')
  const [groups, setGroups] = useState<Group[] | null>(null)
  const [progress, setProgress] = useState<{ scanned: number; total: number } | null>(null)

  useEffect(() => {
    if (!open) {
      setGroups(null)
      setProgress(null)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const files = await loadVaultMarkdownFiles()
        if (cancelled) return
        const limit = Math.min(files.length, SCAN_LIMIT)
        setProgress({ scanned: 0, total: limit })
                                    
        const byBase = new Map<string, string>()
        const byFull = new Map<string, string>()
        for (const f of files) {
          byFull.set(lowercased(f.path), f.path)
          byBase.set(lowercased(basename(f.path)), f.path)
        }
        const collected: Group[] = []
        for (let i = 0; i < limit; i++) {
          if (cancelled) return
          const path = files[i].path
          try {
            const doc = await readWorkspaceDocument(path)
            const content = doc.content ?? ''
            const links = parseWikilinks(content)
            const broken: BrokenRef[] = []
            for (const link of links) {
              if (!link.target) continue
              const tgt = lowercased(link.target).replace(/\.md$/i, '')
              const hit = byFull.get(`${tgt}.md`) ?? byBase.get(tgt)
              if (hit) continue
              const line = (content.slice(0, link.from).match(/\n/g)?.length ?? 0) + 1
              broken.push({ target: link.target, line, raw: link.raw })
            }
            if (broken.length > 0) collected.push({ path, refs: broken })
          } catch {
            /* skip */
          }
          setProgress({ scanned: i + 1, total: limit })
        }
        if (!cancelled) setGroups(collected)
      } catch {
        if (!cancelled) setGroups([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open])

  const totalBroken = groups?.reduce((s, g) => s + g.refs.length, 0) ?? 0

  const handleCreate = async (target: string, sourcePath: string) => {
                                         
    const dir = sourcePath.includes('/') ? sourcePath.slice(0, sourcePath.lastIndexOf('/') + 1) : ''
    const cleanTarget = target.replace(/\.md$/i, '')
    const newPath = `${dir}${cleanTarget}.md`
    try {
      await writeWorkspaceDocument(newPath, `# ${cleanTarget}\n\n`)
      clearVaultFileCache()
      onOpenChange(false)
      onOpen(newPath)
    } catch (err) {
      console.warn('create-from-broken-link failed', err)
      notify.error(t('common.createFailed'), { description: newPath })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-amber-500" />
            {td('dialog.brokenLinks.title')}
          </DialogTitle>
          <DialogDescription>
            {groups
              ? totalBroken === 0
                ? td('dialog.brokenLinks.noBroken')
                : td('dialog.brokenLinks.summary', { count: totalBroken, files: groups.length })
              : progress
                ? td('dialog.brokenLinks.scanning', { scanned: progress.scanned, total: progress.total })
                : td('dialog.brokenLinks.preparing')}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[55vh] space-y-2 overflow-auto">
          {groups?.map((g) => (
            <div key={g.path} className="rounded border border-border/40">
              <button
                type="button"
                onClick={() => {
                  onOpenChange(false)
                  onOpen(g.path)
                }}
                className="block w-full truncate border-b border-border/40 bg-muted/30 px-2 py-1 text-left text-xs font-semibold hover:bg-muted/50"
                title={g.path}
              >
                {g.path}{' '}
                <span className="text-muted-foreground font-normal">
                  · {td('dialog.brokenLinks.groupRefCount', { count: g.refs.length })}
                </span>
              </button>
              <div className="space-y-0.5 px-2 py-1">
                {g.refs.map((r, i) => (
                  <div
                    key={`${g.path}-${i}`}
                    className="flex w-full items-center gap-2 rounded px-1 py-0.5 hover:bg-accent/40"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        onOpenChange(false)
                        onOpen(g.path, r.line)
                      }}
                      className="flex flex-1 items-center gap-2 truncate text-left text-[11px]"
                    >
                      <span className="shrink-0 font-mono text-muted-foreground">L{r.line}</span>
                      <code className="truncate text-amber-700 dark:text-amber-400">
                        {r.raw}
                      </code>
                      <span className="ml-auto shrink-0 text-muted-foreground">
                        → {r.target}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleCreate(r.target, g.path)}
                      className="ml-1 flex shrink-0 items-center gap-1 rounded border border-border/40 bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground transition hover:bg-accent/40 hover:text-foreground"
                      title={td('dialog.brokenLinks.createTooltip', { target: r.target })}
                    >
                      <FilePlus className="size-3" />
                      {td('dialog.brokenLinks.createAction')}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
