   
                   
  
                                             
                             
  
                       
   

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/registry/ui/dialog'
import { readWorkspaceDocument } from '@/services/desktop'

import { parseWikilinks } from '../lib/wikilink-parser'
import { loadVaultMarkdownFiles } from '../vault/vault-files'

const SCAN_LIMIT = 400

export type DocumentLocalGraphDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  currentPath: string
  onOpen: (path: string) => void
}

type Neighbor = {
  path: string
  name: string
  direction: 'out' | 'in' | 'both'
}

function basename(path: string): string {
  const seg = path.split('/').pop() ?? path
  return seg.replace(/\.md$/i, '')
}

function lowercased(s: string): string {
  return s.toLowerCase()
}

export function DocumentLocalGraphDialog({
  open,
  onOpenChange,
  currentPath,
  onOpen,
}: DocumentLocalGraphDialogProps) {
  const { t } = useTranslation('document')
  const [neighbors, setNeighbors] = useState<Neighbor[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const runRef = useRef(0)

  useEffect(() => {
    if (!open || !currentPath) {
      setNeighbors(null)
      setError(null)
      return
    }
    const run = ++runRef.current
    setNeighbors(null)
    setError(null)
    void (async () => {
      try {
        const files = await loadVaultMarkdownFiles()
        if (runRef.current !== run) return
                            
        const currentDoc = await readWorkspaceDocument(currentPath)
        if (runRef.current !== run) return
        const outRaw = parseWikilinks(currentDoc.content ?? '')
        const fileByBase = new Map<string, string>()
        const fileByFull = new Map<string, string>()
        for (const f of files) {
          fileByFull.set(lowercased(f.path), f.path)
          fileByBase.set(lowercased(basename(f.path)), f.path)
        }
        const outPaths = new Set<string>()
        for (const link of outRaw) {
          if (!link.target) continue
          const t = lowercased(link.target).replace(/\.md$/i, '')
          const hit = fileByFull.get(`${t}.md`) ?? fileByBase.get(t)
          if (hit && hit !== currentPath) outPaths.add(hit)
        }
                                          
        const inPaths = new Set<string>()
        const currentBase = lowercased(basename(currentPath))
        const limit = Math.min(files.length, SCAN_LIMIT)
        for (let i = 0; i < limit; i++) {
          if (runRef.current !== run) return
          const path = files[i].path
          if (path === currentPath) continue
          try {
            const doc = await readWorkspaceDocument(path)
            const links = parseWikilinks(doc.content ?? '')
            for (const link of links) {
              if (!link.target) continue
              const t = lowercased(link.target).replace(/\.md$/i, '')
              if (t === currentBase || t === lowercased(currentPath).replace(/\.md$/i, '')) {
                inPaths.add(path)
                break
              }
            }
          } catch {
            /* skip */
          }
        }
        if (runRef.current !== run) return
        const all = new Map<string, Neighbor>()
        for (const p of outPaths) all.set(p, { path: p, name: basename(p), direction: 'out' })
        for (const p of inPaths) {
          const existing = all.get(p)
          if (existing) existing.direction = 'both'
          else all.set(p, { path: p, name: basename(p), direction: 'in' })
        }
        setNeighbors(Array.from(all.values()))
      } catch (e) {
        if (runRef.current !== run) return
        setError(String((e as Error)?.message ?? e))
      }
    })()
  }, [open, currentPath])

  const layout = useMemo(() => {
    if (!neighbors) return null
    const W = 540
    const H = 380
    const cx = W / 2
    const cy = H / 2
    const radius = Math.min(W, H) / 2 - 50
    const n = neighbors.length
    const positions = neighbors.map((nb, i) => {
      const angle = n === 0 ? 0 : (i / n) * Math.PI * 2 - Math.PI / 2
      return {
        ...nb,
        x: cx + radius * Math.cos(angle),
        y: cy + radius * Math.sin(angle),
      }
    })
    return { W, H, cx, cy, positions }
  }, [neighbors])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('dialog.localGraph.title')}</DialogTitle>
          <DialogDescription>{t('dialog.localGraph.description')}</DialogDescription>
        </DialogHeader>
        {error ? (
          <div className="text-sm text-destructive">{t('dialog.localGraph.loadFailed', { message: error })}</div>
        ) : !layout ? (
          <div className="text-sm text-muted-foreground">{t('dialog.localGraph.scanning')}</div>
        ) : layout.positions.length === 0 ? (
          <div className="text-sm text-muted-foreground">{t('dialog.localGraph.noLinks')}</div>
        ) : (
          <svg
            viewBox={`0 0 ${layout.W} ${layout.H}`}
            className="w-full rounded-md border border-border/40 bg-muted/10"
            style={{ maxHeight: 420 }}
          >
            {layout.positions.map((p) => (
              <line
                key={`edge-${p.path}`}
                x1={layout.cx}
                y1={layout.cy}
                x2={p.x}
                y2={p.y}
                stroke="currentColor"
                strokeOpacity={p.direction === 'both' ? 0.5 : 0.25}
                strokeWidth={p.direction === 'both' ? 2 : 1}
              />
            ))}
            <circle cx={layout.cx} cy={layout.cy} r={14} className="fill-primary" />
            <text
              x={layout.cx}
              y={layout.cy + 28}
              textAnchor="middle"
              className="fill-foreground text-[12px] font-semibold"
            >
              {basename(currentPath)}
            </text>
            {layout.positions.map((p) => (
              <g
                key={`node-${p.path}`}
                onClick={() => {
                  onOpenChange(false)
                  queueMicrotask(() => onOpen(p.path))
                }}
                className="cursor-pointer"
              >
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={9}
                  className={
                    p.direction === 'out'
                      ? 'fill-blue-500/80'
                      : p.direction === 'in'
                        ? 'fill-amber-500/80'
                        : 'fill-emerald-500/80'
                  }
                />
                <text
                  x={p.x}
                  y={p.y + 22}
                  textAnchor="middle"
                  className="fill-foreground/80 text-[11px]"
                >
                  {p.name.length > 22 ? p.name.slice(0, 20) + '…' : p.name}
                </text>
              </g>
            ))}
          </svg>
        )}
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <Legend color="fill-blue-500/80" label={t('dialog.localGraph.legendOutgoing')} />
          <Legend color="fill-amber-500/80" label={t('dialog.localGraph.legendIncoming')} />
          <Legend color="fill-emerald-500/80" label={t('dialog.localGraph.legendBoth')} />
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <svg width={10} height={10} viewBox="0 0 10 10">
        <circle cx={5} cy={5} r={4} className={color} />
      </svg>
      {label}
    </span>
  )
}
