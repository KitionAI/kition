   
                    
  
                             
                       
  
                         
                
                         
                              
                   
                   
                              
                    
                           
                      
                   
                                                       
                                       
  
                      
   

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

export type LintIssue = {
  rule: string
  /** i18n key (relative to `document:dialog.markdownLint.messages`) */
  messageKey: string
  /** interpolation params for the message key */
  messageParams?: Record<string, string | number>
  lineNo: number
                               
  col: number
  severity: 'warn' | 'info'
}

const HEADING_RE = /^(\s*)(#{1,6})(\s*)(.*)$/

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\s-]/gu, '')
    .replace(/\s+/g, '-')
}

export function lintMarkdown(source: string): LintIssue[] {
  const issues: LintIssue[] = []
  const lines = source.split(/\r?\n/)
  let inFence = false
  let h1Count = 0
  const headingSlugs = new Set<string>()

               
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]
    if (/^\s*```/.test(text)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = HEADING_RE.exec(text)
    if (m) {
      const hashes = m[2]
      const space = m[3]
      const body = m[4]
      if (hashes.length === 1) h1Count += 1
      headingSlugs.add(slugify(body))
      if (space.length === 0 && body.length > 0) {
        issues.push({ rule: 'MD018', messageKey: 'md018_missingSpace', lineNo: i + 1, col: 1, severity: 'warn' })
      }
      if (space.length > 1) {
        issues.push({ rule: 'MD019', messageKey: 'md019_extraSpace', lineNo: i + 1, col: 1, severity: 'info' })
      }
      if (/[\p{Sentence_Terminal}:;]$/u.test(body.trim())) {
        issues.push({ rule: 'MD026', messageKey: 'md026_trailingPunct', lineNo: i + 1, col: 1, severity: 'info' })
      }
             
      if (i > 0 && lines[i - 1].trim() !== '') {
        issues.push({ rule: 'MD022', messageKey: 'md022_blankBefore', lineNo: i + 1, col: 1, severity: 'info' })
      }
      if (i < lines.length - 1 && lines[i + 1].trim() !== '' && !HEADING_RE.test(lines[i + 1])) {
        issues.push({ rule: 'MD022', messageKey: 'md022_blankAfter', lineNo: i + 1, col: 1, severity: 'info' })
      }
    }
  }

  if (h1Count > 1) {
    issues.unshift({
      rule: 'MD001',
      messageKey: 'md001_multiH1',
      messageParams: { count: h1Count },
      lineNo: 1,
      col: 1,
      severity: 'warn',
    })
  }

                          
  inFence = false
  let blankRun = 0
  let lastOrderedIndent: string | null = null
  let lastOrderedCounter = 0
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]
    if (/^\s*```/.test(text)) {
      inFence = !inFence
      if (inFence) {
        const lang = text.replace(/^\s*```/, '').trim()
        if (lang === '') {
          issues.push({ rule: 'MD040', messageKey: 'md040_fenceLang', lineNo: i + 1, col: 1, severity: 'info' })
        }
      }
      blankRun = 0
      lastOrderedIndent = null
      lastOrderedCounter = 0
      continue
    }
    if (inFence) continue
    // MD009 trailing whitespace
    if (/[ \t]+$/.test(text)) {
      issues.push({ rule: 'MD009', messageKey: 'md009_trailingWhitespace', lineNo: i + 1, col: text.length, severity: 'info' })
    }
    // MD012 multiple blank lines
    if (text.trim() === '') {
      blankRun += 1
      if (blankRun === 3) {
        issues.push({ rule: 'MD012', messageKey: 'md012_blankRun', lineNo: i + 1, col: 1, severity: 'info' })
      }
      lastOrderedIndent = null
      lastOrderedCounter = 0
      continue
    } else {
      blankRun = 0
    }
    // MD029 ordered list numbering
    const ol = /^(\s*)(\d+)\.\s+/.exec(text)
    if (ol) {
      const indent = ol[1]
      const n = Number(ol[2])
      if (indent !== lastOrderedIndent) {
        lastOrderedIndent = indent
        lastOrderedCounter = n
      } else {
        lastOrderedCounter += 1
        if (n !== lastOrderedCounter && n !== 1) {
          issues.push({
            rule: 'MD029',
            messageKey: 'md029_orderNumber',
            messageParams: { actual: n, expected: lastOrderedCounter },
            lineNo: i + 1,
            col: 1,
            severity: 'info',
          })
          lastOrderedCounter = n
        }
      }
    } else {
      lastOrderedIndent = null
      lastOrderedCounter = 0
    }
                                          
    if (/^\s*\*\*[^*\n]+\*\*\s*$/.test(text)) {
      issues.push({ rule: 'MD036', messageKey: 'md036_boldAsHeading', lineNo: i + 1, col: 1, severity: 'info' })
    }
    // MD034 bare URL
    const bareUrl = /(?:^|[^("[<])(https?:\/\/[^\s)<>\]]+)/.exec(text)
    if (bareUrl) {
      issues.push({
        rule: 'MD034',
        messageKey: 'md034_bareUrl',
        lineNo: i + 1,
        col: bareUrl.index + 1,
        severity: 'info',
      })
    }
    // MD042 empty wikilink / empty markdown link
    if (/\[\[\s*\]\]/.test(text)) {
      issues.push({ rule: 'MD042', messageKey: 'md042_emptyWikilink', lineNo: i + 1, col: 1, severity: 'warn' })
    }
    const mdEmpty = /\[([^\]]*)\]\(\s*\)/.exec(text)
    if (mdEmpty) {
      issues.push({
        rule: 'MD042',
        messageKey: 'md042_emptyMarkdown',
        messageParams: { text: mdEmpty[1] || '' },
        lineNo: i + 1,
        col: mdEmpty.index + 1,
        severity: 'warn',
      })
    }
    // MD051 anchor link to non-existent heading
    const anchor = /\[[^\]]+\]\(#([^\s)]+)\)/.exec(text)
    if (anchor) {
      const target = decodeURIComponent(anchor[1]).toLowerCase()
      if (!headingSlugs.has(target)) {
        issues.push({
          rule: 'MD051',
          messageKey: 'md051_anchorNotFound',
          messageParams: { anchor: anchor[1] },
          lineNo: i + 1,
          col: anchor.index + 1,
          severity: 'warn',
        })
      }
    }
  }

                 
  issues.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'warn' ? -1 : 1
    return a.lineNo - b.lineNo
  })
  return issues
}

export type DocumentMarkdownLintDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  source: string
  getView: () => EditorView | null
}

export function DocumentMarkdownLintDialog({
  open,
  onOpenChange,
  source,
  getView,
}: DocumentMarkdownLintDialogProps) {
  const { t } = useTranslation('document')
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  const issues = useMemo(() => (open ? lintMarkdown(source) : []), [open, source])

  const resolveMessage = (issue: LintIssue): string =>
    t(`dialog.markdownLint.messages.${issue.messageKey}`, issue.messageParams ?? {})

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return issues
    return issues.filter(
      (it) =>
        resolveMessage(it).toLowerCase().includes(q)
        || it.rule.toLowerCase().includes(q),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issues, query, t])

  const jumpTo = (issue: LintIssue) => {
    const view = getView()
    if (!view) {
      onOpenChange(false)
      return
    }
    onOpenChange(false)
    queueMicrotask(() => {
      const line = view.state.doc.line(Math.min(issue.lineNo, view.state.doc.lines))
      const pos = line.from + Math.min(issue.col - 1, line.length)
      view.dispatch({
        selection: EditorSelection.cursor(pos),
        effects: EditorView.scrollIntoView(pos, { y: 'center' }),
      })
      view.focus()
    })
  }

  const warnCount = issues.filter((i) => i.severity === 'warn').length
  const infoCount = issues.length - warnCount

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput
        placeholder={t('dialog.markdownLint.summary', { warn: warnCount, info: infoCount })}
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>
          {issues.length === 0 ? t('dialog.markdownLint.noIssues') : t('dialog.markdownLint.noMatches')}
        </CommandEmpty>
        {filtered.length > 0 ? (
          <CommandGroup heading={t('dialog.markdownLint.groupCount', { count: filtered.length })}>
            {filtered.map((it, idx) => {
              const message = resolveMessage(it)
              return (
                <CommandItem
                  key={`${it.rule}-${it.lineNo}-${idx}`}
                  value={`${it.rule} ${message} ${it.lineNo}`}
                  onSelect={() => jumpTo(it)}
                  className="flex items-center gap-2"
                >
                  <span
                    className={
                      'rounded px-1.5 py-0.5 text-[10px] font-semibold '
                      + (it.severity === 'warn'
                        ? 'bg-yellow-500/20 text-yellow-700 dark:text-yellow-300'
                        : 'bg-muted text-muted-foreground')
                    }
                  >
                    {it.rule}
                  </span>
                  <span className="flex-1 truncate text-[13px]">{message}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    L{it.lineNo}
                  </span>
                </CommandItem>
              )
            })}
          </CommandGroup>
        ) : null}
      </CommandList>
    </CommandDialog>
  )
}
