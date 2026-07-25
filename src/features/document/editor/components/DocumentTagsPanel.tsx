   
          
  
                                                     
                   
  
                         
                                         
                                                     
                       
   

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { parseTags, type TagParsed } from '@/features/document/editor/lib/tag-parser'
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

export type DocumentTagsPanelProps = {
               
  source: string
                       
  currentPath: string
                       
  onSelectInDocument?: (tag: TagParsed) => void
                                    
  onSelectGlobalTag?: (name: string) => void
  className?: string
}

export function DocumentTagsPanel({
  source,
  currentPath,
  onSelectInDocument,
  onSelectGlobalTag,
  className,
}: DocumentTagsPanelProps) {
  const { t } = useTranslation('document')
  const [vaultCounts, setVaultCounts] = useState<Map<string, number> | null>(null)
  const [scanning, setScanning] = useState(false)

  const localTags = useMemo(() => parseTags(source), [source])
  const localUnique = useMemo(() => {
    const map = new Map<string, TagParsed[]>()
    for (const t of localTags) {
      const arr = map.get(t.name) ?? []
      arr.push(t)
      map.set(t.name, arr)
    }
    return map
  }, [localTags])

  useEffect(() => {
    let cancelled = false
    async function scan() {
      setScanning(true)
      const counter = new Map<string, number>()
      try {
        const resp = await vaultClient.list()
        const files = flattenTree(resp.items).filter(
          (t) => t.type === 'file' && /\.md$/i.test(t.path),
        )
        const limit = Math.min(files.length, 300)
        for (let i = 0; i < limit; i++) {
          if (cancelled) return
          const file = files[i]
          let content = ''
          if (file.path === currentPath) {
            content = source
          } else {
            try {
              const doc = await readWorkspaceDocument(file.path)
              content = doc.content ?? ''
            } catch {
              continue
            }
          }
          const tags = parseTags(content)
          const localSeen = new Set<string>()
          for (const t of tags) {
            if (localSeen.has(t.name)) continue
            localSeen.add(t.name)
            counter.set(t.name, (counter.get(t.name) ?? 0) + 1)
          }
        }
        if (!cancelled) {
          setVaultCounts(counter)
          setScanning(false)
        }
      } catch {
        if (!cancelled) {
          setVaultCounts(new Map())
          setScanning(false)
        }
      }
    }
    void scan()
    return () => {
      cancelled = true
    }
  }, [currentPath, source])

  const sortedVault = useMemo(() => {
    if (!vaultCounts) return []
    return Array.from(vaultCounts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 200)
  }, [vaultCounts])

  return (
    <div className={cn('document-tags flex flex-col gap-3 p-2 text-sm', className)}>
      <section>
        <div className="px-1 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {t('panels.tags.localSection', { count: localUnique.size })}
        </div>
        {localUnique.size === 0 ? (
          <div className="px-2 py-1 text-[12px] text-muted-foreground">{t('panels.tags.noLocalTags')}</div>
        ) : (
          <div className="flex flex-wrap gap-1">
            {Array.from(localUnique.entries()).map(([name, occurrences]) => (
              <button
                key={name}
                type="button"
                onClick={() => onSelectInDocument?.(occurrences[0])}
                title={t('panels.tags.localOccurrences', { count: occurrences.length })}
                className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background px-2 py-0.5 text-[11px] text-foreground transition hover:border-accent hover:bg-accent/30"
              >
                <span>#{name}</span>
                {occurrences.length > 1 ? (
                  <span className="text-[10px] text-muted-foreground">×{occurrences.length}</span>
                ) : null}
              </button>
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="px-1 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {scanning
            ? t('panels.tags.vaultSectionScanning', { count: sortedVault.length })
            : t('panels.tags.vaultSection', { count: sortedVault.length })}
        </div>
        {sortedVault.length === 0 ? (
          <div className="px-2 py-1 text-[12px] text-muted-foreground">
            {scanning ? t('panels.tags.vaultEmptyScanning') : t('panels.tags.vaultEmpty')}
          </div>
        ) : (
          <div className="flex flex-col">
            {sortedVault.map(([name, count]) => (
              <button
                key={name}
                type="button"
                onClick={() => onSelectGlobalTag?.(name)}
                className="flex items-center justify-between gap-2 rounded px-2 py-1 text-left text-[12px] transition hover:bg-accent/40"
                title={t('panels.tags.globalSearchTitle', { name })}
              >
                <span className="truncate">#{name}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground">{count}</span>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
