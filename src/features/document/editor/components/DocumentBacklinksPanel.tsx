   
               
  
                                                                         
                                                  
  
                                              
   

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { parseWikilinks } from '@/features/document/editor/lib/wikilink-parser'
import { vaultClient, type VaultTreeItem } from '@/features/document/editor/vault/vault-client'
import { readWorkspaceDocument } from '@/services/desktop'
import { cn } from '@/lib/utils'

function flattenTree(items: VaultTreeItem[], out: VaultTreeItem[] = []): VaultTreeItem[] {
  for (const item of items) {
    out.push(item)
    if (item.children?.length) flattenTree(item.children, out)
  }
  return out
}

function stripMd(p: string) {
  return p.replace(/\.md$/i, '')
}

function lastSegment(p: string) {
  const idx = p.lastIndexOf('/')
  return idx >= 0 ? p.slice(idx + 1) : p
}

export type BacklinkHit = {
  sourcePath: string
  line: number
  preview: string
}

export type DocumentBacklinksPanelProps = {
                         
  currentPath: string
  onSelect?: (path: string, line: number) => void
  className?: string
}

export function DocumentBacklinksPanel({
  currentPath,
  onSelect,
  className,
}: DocumentBacklinksPanelProps) {
  const { t } = useTranslation('document')
  const [hits, setHits] = useState<BacklinkHit[] | null>(null)
  const [scanning, setScanning] = useState(false)

  const matchers = useMemo(() => {
    const noExt = stripMd(currentPath).toLowerCase()
    const base = stripMd(lastSegment(currentPath)).toLowerCase()
    return { noExt, base }
  }, [currentPath])

  useEffect(() => {
    let cancelled = false
    async function scan() {
      setScanning(true)
      setHits(null)
      const found: BacklinkHit[] = []
      try {
        const resp = await vaultClient.list()
        const files = flattenTree(resp.items).filter(
          (t) => t.type === 'file' && /\.md$/i.test(t.path) && t.path !== currentPath,
        )
        const limit = Math.min(files.length, 500)
        for (let i = 0; i < limit; i++) {
          if (cancelled) return
          const file = files[i]
          let content = ''
          try {
            const doc = await readWorkspaceDocument(file.path)
            content = doc.content ?? ''
          } catch {
            continue
          }
          const wikis = parseWikilinks(content)
          if (wikis.length === 0) continue
          const lines = content.split(/\r?\n/)
          for (const w of wikis) {
            const targetLower = w.target.toLowerCase()
            if (targetLower !== matchers.noExt && targetLower !== matchers.base) continue
            const lineIdx = content.slice(0, w.from).split('\n').length - 1
            const preview = lines[lineIdx]?.trim().slice(0, 160) ?? ''
            found.push({ sourcePath: file.path, line: lineIdx + 1, preview })
          }
        }
        if (!cancelled) {
          setHits(found)
          setScanning(false)
        }
      } catch {
        if (!cancelled) {
          setHits([])
          setScanning(false)
        }
      }
    }
    void scan()
    return () => {
      cancelled = true
    }
  }, [currentPath, matchers.noExt, matchers.base])

  if (scanning && hits === null) {
    return (
      <div className={cn('document-backlinks-empty p-3 text-xs text-muted-foreground', className)}>
        {t('panels.backlinks.scanning')}
      </div>
    )
  }

  if (!hits || hits.length === 0) {
    return (
      <div className={cn('document-backlinks-empty p-3 text-xs text-muted-foreground', className)}>
        {t('panels.backlinks.empty')}
      </div>
    )
  }

           
  const byFile = new Map<string, BacklinkHit[]>()
  for (const h of hits) {
    const arr = byFile.get(h.sourcePath) ?? []
    arr.push(h)
    byFile.set(h.sourcePath, arr)
  }

  return (
    <div className={cn('document-backlinks flex flex-col gap-2 p-2 text-sm', className)}>
      <div className="px-1 text-[11px] text-muted-foreground">
        {t('panels.backlinks.summary', { count: hits.length, files: byFile.size })}
      </div>
      {Array.from(byFile.entries()).map(([path, items]) => (
        <div key={path} className="flex flex-col gap-1">
          <div className="px-1 text-[11px] font-medium text-muted-foreground">
            {stripMd(lastSegment(path))}
          </div>
          {items.map((h, idx) => (
            <button
              key={`${path}-${h.line}-${idx}`}
              type="button"
              onClick={() => onSelect?.(path, h.line)}
              className="rounded px-2 py-1 text-left text-[12px] leading-snug transition hover:bg-accent/40"
              title={t('panels.backlinks.lineTitle', { path, line: h.line })}
            >
              <span className="line-clamp-2">{h.preview || t('panels.backlinks.emptyLine')}</span>
              <span className="mt-0.5 block text-[10px] text-muted-foreground">{t('panels.backlinks.lineLabel', { line: h.line })}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}
