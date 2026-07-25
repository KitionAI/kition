   
         
  
                                              
                               
   

import { ExternalLink } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { parseWikilinks } from '../lib/wikilink-parser'
import { loadVaultMarkdownFiles } from '../vault/vault-files'

export type DocumentOutgoingLinksPanelProps = {
  source: string
  currentPath?: string | null
  onOpen: (path: string) => void
}

type Row = {
  target: string
  count: number
  display?: string
  resolvedPath?: string
}

function basename(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.md$/i, '')
}

function lowercased(s: string): string {
  return s.toLowerCase()
}

export function DocumentOutgoingLinksPanel({
  source,
  currentPath,
  onOpen,
}: DocumentOutgoingLinksPanelProps) {
  const { t } = useTranslation('document')
  const [fileLookup, setFileLookup] = useState<{
    base: Map<string, string>
    full: Map<string, string>
  } | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const files = await loadVaultMarkdownFiles()
        if (cancelled) return
        const base = new Map<string, string>()
        const full = new Map<string, string>()
        for (const f of files) {
          full.set(lowercased(f.path), f.path)
          base.set(lowercased(basename(f.path)), f.path)
        }
        setFileLookup({ base, full })
      } catch {
        if (!cancelled) setFileLookup({ base: new Map(), full: new Map() })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const rows = useMemo<Row[]>(() => {
    const parsed = parseWikilinks(source)
    const map = new Map<string, Row>()
    for (const link of parsed) {
      if (!link.target) continue
      const t = link.target.trim()
      const key = lowercased(t).replace(/\.md$/i, '')
      const existing = map.get(key)
      if (existing) {
        existing.count += 1
        if (!existing.display && link.display) existing.display = link.display
      } else {
        let resolved: string | undefined
        if (fileLookup) {
          resolved = fileLookup.full.get(`${key}.md`) ?? fileLookup.base.get(key)
        }
        map.set(key, {
          target: t,
          display: link.display ?? undefined,
          count: 1,
          resolvedPath: resolved,
        })
      }
    }
    return Array.from(map.values()).sort((a, b) =>
      (a.resolvedPath ? 0 : 1) - (b.resolvedPath ? 0 : 1) || a.target.localeCompare(b.target),
    )
  }, [source, fileLookup])

  if (rows.length === 0) {
    return (
      <div className="px-2 py-4 text-center text-xs text-muted-foreground">
        {t('panels.outgoing.empty')}
      </div>
    )
  }

  return (
    <div className="space-y-0.5 p-1">
      {rows.map((r) => {
        const labelText = r.display ?? r.target
        const disabled = !r.resolvedPath
        return (
          <button
            key={r.target}
            type="button"
            disabled={disabled}
            onClick={() => r.resolvedPath && onOpen(r.resolvedPath)}
            className={
              'flex w-full items-center gap-1.5 truncate rounded px-2 py-1 text-left text-xs '
              + (disabled
                ? 'cursor-default text-muted-foreground/60 italic'
                : (r.resolvedPath === currentPath
                  ? 'bg-accent/40'
                  : 'hover:bg-accent/40'))
            }
            title={r.resolvedPath ?? t('panels.outgoing.unresolved', { target: r.target })}
          >
            <ExternalLink className="size-3 shrink-0 opacity-60" />
            <span className="truncate">{labelText}</span>
            {r.count > 1 ? (
              <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">×{r.count}</span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}
