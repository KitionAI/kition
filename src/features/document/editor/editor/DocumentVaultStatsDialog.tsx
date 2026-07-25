   
               
  
                     
         
                       
          
           
                        
                        
  
                    
   

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/registry/ui/dialog'
import { readWorkspaceDocument } from '@/services/desktop'
import { getCurrentLocale } from '@/i18n'

import { parseTags } from '../lib/tag-parser'
import { parseWikilinks } from '../lib/wikilink-parser'
import { loadVaultMarkdownFiles } from '../vault/vault-files'

const SCAN_LIMIT = 500

function countWords(text: string): number {
  if (!text) return 0
  const cjk = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0
  const alpha = text
    .replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length
  return cjk + alpha
}

export type DocumentVaultStatsDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

type Stats = {
  files: number
  words: number
  chars: number
  uniqueTags: number
  uniqueLinks: number
  totalLinkRefs: number
  scanned: number
  total: number
}

export function DocumentVaultStatsDialog({ open, onOpenChange }: DocumentVaultStatsDialogProps) {
  const { t } = useTranslation('document')
  const [stats, setStats] = useState<Stats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const runRef = useRef(0)

  useEffect(() => {
    if (!open) {
      setStats(null)
      setError(null)
      return
    }
    const run = ++runRef.current
    setStats(null)
    setError(null)
    void (async () => {
      try {
        const files = await loadVaultMarkdownFiles()
        if (runRef.current !== run) return
        const acc: Stats = {
          files: 0,
          words: 0,
          chars: 0,
          uniqueTags: 0,
          uniqueLinks: 0,
          totalLinkRefs: 0,
          scanned: 0,
          total: Math.min(files.length, SCAN_LIMIT),
        }
        const tagSet = new Set<string>()
        const linkSet = new Set<string>()
        const limit = Math.min(files.length, SCAN_LIMIT)
        for (let i = 0; i < limit; i++) {
          if (runRef.current !== run) return
          const path = files[i].path
          try {
            const doc = await readWorkspaceDocument(path)
            const c = doc.content ?? ''
            acc.files += 1
            acc.chars += c.length
            acc.words += countWords(c)
            for (const t of parseTags(c)) tagSet.add(t.name)
            for (const l of parseWikilinks(c)) {
              if (l.target) {
                linkSet.add(l.target.toLowerCase())
                acc.totalLinkRefs += 1
              }
            }
          } catch {
            /* skip unreadable */
          }
          acc.scanned = i + 1
          if (i % 5 === 0 || i === limit - 1) {
            acc.uniqueTags = tagSet.size
            acc.uniqueLinks = linkSet.size
            setStats({ ...acc })
          }
        }
        acc.uniqueTags = tagSet.size
        acc.uniqueLinks = linkSet.size
        setStats({ ...acc })
      } catch (e) {
        if (runRef.current !== run) return
        setError(String((e as Error)?.message ?? e))
      }
    })()
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('dialog.vaultStats.title')}</DialogTitle>
          <DialogDescription>
            {t('dialog.vaultStats.description', { limit: SCAN_LIMIT })}
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <div className="text-sm text-destructive">{t('dialog.vaultStats.loadFailed', { message: error })}</div>
        ) : !stats ? (
          <div className="text-sm text-muted-foreground">{t('dialog.vaultStats.scanning')}</div>
        ) : (
          <div className="space-y-3 text-sm">
            <ProgressRow scanned={stats.scanned} total={stats.total} t={t} />
            <Grid>
              <Cell label={t('dialog.vaultStats.files')} value={stats.files} />
              <Cell label={t('dialog.vaultStats.words')} value={stats.words} />
              <Cell label={t('dialog.vaultStats.chars')} value={stats.chars} />
              <Cell label={t('dialog.vaultStats.uniqueTags')} value={stats.uniqueTags} />
              <Cell label={t('dialog.vaultStats.uniqueLinks')} value={stats.uniqueLinks} />
              <Cell label={t('dialog.vaultStats.totalLinkRefs')} value={stats.totalLinkRefs} />
            </Grid>
            {stats.scanned >= stats.total ? (
              <div className="text-xs text-muted-foreground">{t('dialog.vaultStats.scanComplete')}</div>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function ProgressRow({ scanned, total, t }: { scanned: number; total: number; t: (key: string, opts?: Record<string, unknown>) => string }) {
  const pct = total > 0 ? Math.round((scanned / total) * 100) : 100
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[11px] text-muted-foreground">
        <span>{t('dialog.vaultStats.progressLabel')}</span>
        <span>{t('dialog.vaultStats.progressValue', { scanned, total, pct })}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full bg-primary transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-3">{children}</div>
}

function Cell({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border/40 bg-muted/20 px-3 py-2">
      <div className="text-[10.5px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums">{value.toLocaleString(getCurrentLocale())}</div>
    </div>
  )
}
