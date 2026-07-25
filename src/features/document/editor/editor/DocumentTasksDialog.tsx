   
               
  
                                             
                                        
                 
   

import { CheckSquare2, Loader2, Square } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/registry/ui/dialog'
import { cn } from '@/lib/utils'
import { readWorkspaceDocument } from '@/services/desktop'

import { loadVaultMarkdownFiles } from '../vault/vault-files'

const SCAN_LIMIT = 600
const TASK_RE = /^\s*[-*+]\s+\[( |x|X)\]\s+(.*)$/

export type DocumentTasksDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpen: (path: string, line?: number) => void
}

type TaskItem = {
  text: string
  line: number
  done: boolean
}

type Group = {
  path: string
  tasks: TaskItem[]
}

type Filter = 'all' | 'open' | 'done'

export function DocumentTasksDialog({ open, onOpenChange, onOpen }: DocumentTasksDialogProps) {
  const { t } = useTranslation('document')
  const [groups, setGroups] = useState<Group[] | null>(null)
  const [progress, setProgress] = useState<{ scanned: number; total: number } | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('open')

  useEffect(() => {
    if (!open) {
      setGroups(null)
      setProgress(null)
      setQuery('')
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const files = await loadVaultMarkdownFiles()
        if (cancelled) return
        const limit = Math.min(files.length, SCAN_LIMIT)
        setProgress({ scanned: 0, total: limit })
        const collected: Group[] = []
        for (let i = 0; i < limit; i++) {
          if (cancelled) return
          const path = files[i].path
          try {
            const doc = await readWorkspaceDocument(path)
            const content = doc.content ?? ''
            const lines = content.split('\n')
            const tasks: TaskItem[] = []
            for (let li = 0; li < lines.length; li++) {
              const match = TASK_RE.exec(lines[li])
              if (!match) continue
              tasks.push({
                text: match[2].trim(),
                line: li + 1,
                done: match[1].toLowerCase() === 'x',
              })
            }
            if (tasks.length > 0) collected.push({ path, tasks })
          } catch {
            /* skip unreadable */
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

  const filteredGroups = useMemo(() => {
    if (!groups) return null
    const q = query.trim().toLowerCase()
    const out: Group[] = []
    for (const g of groups) {
      const filtered = g.tasks.filter((t) => {
        if (filter === 'open' && t.done) return false
        if (filter === 'done' && !t.done) return false
        if (q && !t.text.toLowerCase().includes(q)) return false
        return true
      })
      if (filtered.length > 0) out.push({ path: g.path, tasks: filtered })
    }
    return out
  }, [groups, query, filter])

  const totals = useMemo(() => {
    if (!groups) return { all: 0, open: 0, done: 0 }
    let all = 0
    let openCount = 0
    let done = 0
    for (const g of groups) {
      for (const t of g.tasks) {
        all += 1
        if (t.done) done += 1
        else openCount += 1
      }
    }
    return { all, open: openCount, done }
  }, [groups])

  const visibleCount = filteredGroups?.reduce((s, g) => s + g.tasks.length, 0) ?? 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CheckSquare2 className="size-4" />
            {t('dialog.tasksAggregate.title')}
          </DialogTitle>
          <DialogDescription>
            {groups
              ? t('dialog.tasksAggregate.summary', { all: totals.all, open: totals.open, done: totals.done })
              : progress
                ? t('dialog.tasksAggregate.scanning', { scanned: progress.scanned, total: progress.total })
                : t('dialog.tasksAggregate.preparing')}
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 border-b border-border/40 pb-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('dialog.tasksAggregate.filterPlaceholder')}
            className="flex-1 rounded border border-border/40 bg-background px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-ring"
          />
          <FilterChip active={filter === 'all'} onClick={() => setFilter('all')} label={t('dialog.tasksAggregate.filterAll')} count={totals.all} />
          <FilterChip active={filter === 'open'} onClick={() => setFilter('open')} label={t('dialog.tasksAggregate.filterOpen')} count={totals.open} />
          <FilterChip active={filter === 'done'} onClick={() => setFilter('done')} label={t('dialog.tasksAggregate.filterDone')} count={totals.done} />
        </div>
        <div className="max-h-[55vh] space-y-2 overflow-auto">
          {!groups ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t('dialog.tasksAggregate.loading')}
            </div>
          ) : visibleCount === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {query
                ? t('dialog.tasksAggregate.noMatches')
                : filter === 'open'
                  ? t('dialog.tasksAggregate.noOpen')
                  : filter === 'done'
                    ? t('dialog.tasksAggregate.noDone')
                    : t('dialog.tasksAggregate.emptyVault')}
            </div>
          ) : (
            filteredGroups?.map((g) => (
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
                  <span className="font-normal text-muted-foreground">· {t('dialog.tasksAggregate.groupCount', { count: g.tasks.length })}</span>
                </button>
                <ul className="space-y-0.5 px-2 py-1">
                  {g.tasks.map((task, i) => (
                    <li key={`${g.path}-${task.line}-${i}`}>
                      <button
                        type="button"
                        onClick={() => {
                          onOpenChange(false)
                          onOpen(g.path, task.line)
                        }}
                        className="flex w-full items-start gap-2 rounded px-1 py-0.5 text-left text-[12px] hover:bg-accent/40"
                      >
                        <span className="mt-0.5 shrink-0">
                          {task.done ? (
                            <CheckSquare2 className="size-3.5 text-emerald-500" />
                          ) : (
                            <Square className="size-3.5 text-muted-foreground" />
                          )}
                        </span>
                        <span
                          className={cn(
                            'flex-1 truncate',
                            task.done && 'text-muted-foreground line-through',
                          )}
                        >
                          {task.text || t('dialog.tasksAggregate.emptyTask')}
                        </span>
                        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                          L{task.line}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function FilterChip({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean
  onClick: () => void
  label: string
  count: number
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-full px-2 py-0.5 text-[11px] transition',
        active
          ? 'bg-primary text-primary-foreground'
          : 'bg-muted text-muted-foreground hover:bg-accent/60 hover:text-foreground',
      )}
    >
      {label}
      <span className="ml-1 tabular-nums opacity-70">{count}</span>
    </button>
  )
}
