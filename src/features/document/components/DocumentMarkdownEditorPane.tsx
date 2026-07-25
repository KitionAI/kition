   
                             
  
                                      
                                                                                    
                                                           
   

import type { ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { EditorView } from '@codemirror/view'
import { EditorSelection } from '@codemirror/state'
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { useConfirm } from '@/components/confirm'
import { useDesktopSettings } from '@/features/settings/hooks/useDesktopSettings'
import { DocumentBacklinksPanel } from '@/features/document/editor/components/DocumentBacklinksPanel'
import { DocumentBookmarksPanel } from '@/features/document/editor/components/DocumentBookmarksPanel'
import { DocumentExplorerPanel } from '@/features/document/editor/components/DocumentExplorerPanel'
import { DocumentOutgoingLinksPanel } from '@/features/document/editor/components/DocumentOutgoingLinksPanel'
import { DocumentPinnedTabBar } from '@/features/document/editor/components/DocumentPinnedTabBar'
import { DocumentOutlinePanel, parseOutlineHeadings } from '@/features/document/editor/components/DocumentOutlinePanel'
import { DocumentRecentsPanel } from '@/features/document/editor/components/DocumentRecentsPanel'
import { DocumentTagsPanel } from '@/features/document/editor/components/DocumentTagsPanel'
import { appendToDailyNote, ensureDailyNote, ensureDailyNoteFor } from '@/features/document/editor/daily-note'
import { DocumentEditor, type CursorInfo } from '@/features/document/editor/editor/DocumentEditor'
import { DocumentCommandPalette, type PaletteExtra } from '@/features/document/editor/editor/DocumentCommandPalette'
import { buildSectionLinkText, ensureBlockIdAtCursor, exportOutlineToText, getHeadingAtCursor } from '@/features/document/editor/editor/commands'
import { DocumentTemplatesPicker } from '@/features/document/editor/editor/DocumentTemplatesPicker'
import { DocumentVaultStatsDialog } from '@/features/document/editor/editor/DocumentVaultStatsDialog'
import { DocumentLocalGraphDialog } from '@/features/document/editor/editor/DocumentLocalGraphDialog'
import { DocumentDailyCalendar } from '@/features/document/editor/editor/DocumentDailyCalendar'
import { DocumentSnippetsDialog } from '@/features/document/editor/editor/DocumentSnippetsDialog'
import { DocumentTagBrowserDialog } from '@/features/document/editor/editor/DocumentTagBrowserDialog'
import { DocumentPropertiesDialog } from '@/features/document/editor/editor/DocumentPropertiesDialog'
import { DocumentBrokenLinksDialog } from '@/features/document/editor/editor/DocumentBrokenLinksDialog'
import { DocumentTasksDialog } from '@/features/document/editor/editor/DocumentTasksDialog'
import { DocumentBlockJumpDialog } from '@/features/document/editor/editor/DocumentBlockJumpDialog'
import { DocumentGlobalSearch } from '@/features/document/editor/editor/DocumentGlobalSearch'
import { DocumentHeadingJumpDialog } from '@/features/document/editor/editor/DocumentHeadingJumpDialog'
import { DocumentTagsDialog } from '@/features/document/editor/editor/DocumentTagsDialog'
import { DocumentHeadingOutlineDialog } from '@/features/document/editor/editor/DocumentHeadingOutlineDialog'
import { DocumentMarkdownLintDialog } from '@/features/document/editor/editor/DocumentMarkdownLintDialog'
import { DocumentQuickSwitcher } from '@/features/document/editor/editor/DocumentQuickSwitcher'
import { DocumentWordFrequencyDialog } from '@/features/document/editor/editor/DocumentWordFrequencyDialog'
import type { SuggestProviders } from '@/features/document/editor/editor/extensions'
import { documentTitleHostExtension } from '@/features/document/editor/editor/extensions'
import { useVaultSuggestProviders } from '@/features/document/editor/hooks/useVaultSuggestProviders'
import { useVaultEmbedLoader } from '@/features/document/editor/hooks/useVaultEmbedLoader'
import {
  invalidateVaultWikilinkResolver,
  useVaultWikilinkResolver,
} from '@/features/document/editor/hooks/useVaultWikilinkResolver'
import { useBookmarksActions, useIsBookmarked } from '@/features/document/editor/hooks/useBookmarks'
import { togglePinTab, isTabPinned } from '@/features/document/editor/hooks/usePinnedTabs'
import { clearRecentFiles, pushRecentFile } from '@/features/document/editor/hooks/useRecentFiles'
import { useWordGoal } from '@/features/document/editor/hooks/useWordGoal'
import { pickRandomMarkdownFile } from '@/features/document/editor/vault/vault-files'
import { clearVaultFileCache } from '@/features/document/editor/vault/vault-files'
import { writeWorkspaceDocument } from '@/services/desktop'
import { DocumentEditorToolbar } from '@/features/document/editor/editor/DocumentEditorToolbar'
import { DocumentTitleHostPortal } from '@/features/document/components/DocumentTitleHostPortal'
import { notify } from '@/lib/notify'
import { cn } from '@/lib/utils'

export type DocumentMarkdownEditorPaneProps = {
  value: string
  readOnly: boolean
  onChange: (value: string) => void
  documentPath: string
  suggestProviders?: SuggestProviders
                                        
  onNavigate?: (path: string, opts?: { line?: number; section?: string }) => void
                                                
  inlineTitleSlot?: ReactNode
                                                 
  onToolbarMount?: (node: HTMLElement | null) => void
                                        
  readingView?: boolean
                                               
  onSetReadingView?: (next: boolean) => void
}

type SideTab = 'outline' | 'backlinks' | 'outgoing' | 'tags' | 'recents' | 'bookmarks' | 'explorer'

const VALID_SIDE_TABS: ReadonlySet<SideTab> = new Set([
  'outline', 'backlinks', 'outgoing', 'tags', 'recents', 'bookmarks', 'explorer',
])
const LAYOUT_KEY_OPEN = 'kition.document.layout.sideOpen'
const LAYOUT_KEY_TAB = 'kition.document.layout.sideTab'

function readSideOpen(): boolean {
  try {
    return localStorage.getItem(LAYOUT_KEY_OPEN) === '1'
  } catch {
    return false
  }
}

function readSideTab(): SideTab {
  try {
    const v = localStorage.getItem(LAYOUT_KEY_TAB) ?? ''
    if (VALID_SIDE_TABS.has(v as SideTab)) return v as SideTab
  } catch {
    /* ignore */
  }
  return 'outline'
}

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

export const DocumentMarkdownEditorPane = memo(function DocumentMarkdownEditorPane({
  value,
  readOnly,
  onChange,
  documentPath,
  suggestProviders,
  onNavigate,
  inlineTitleSlot,
  onToolbarMount,
  readingView = false,
  onSetReadingView,
}: DocumentMarkdownEditorPaneProps) {
  const { t } = useTranslation('errors')
  const { t: td } = useTranslation('document')
  const confirm = useConfirm()
  const { settings } = useDesktopSettings()
  const editorRef = useRef<ReactCodeMirrorRef | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const getView = useCallback(() => editorRef.current?.view ?? null, [])
  const [sideOpen, setSideOpen] = useState(() => readSideOpen())
  const [sideTab, setSideTab] = useState<SideTab>(() => readSideTab())
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false)
  const [templatesOpen, setTemplatesOpen] = useState(false)
  const [vaultStatsOpen, setVaultStatsOpen] = useState(false)
  const [graphOpen, setGraphOpen] = useState(false)
  const [calendarOpen, setCalendarOpen] = useState(false)
  const [snippetsOpen, setSnippetsOpen] = useState(false)
  const [tagBrowserOpen, setTagBrowserOpen] = useState(false)
  const [propertiesOpen, setPropertiesOpen] = useState(false)
  const [brokenLinksOpen, setBrokenLinksOpen] = useState(false)
  const [tasksOpen, setTasksOpen] = useState(false)
  const [headingJumpOpen, setHeadingJumpOpen] = useState(false)
  const [blockJumpOpen, setBlockJumpOpen] = useState(false)
  const [lintOpen, setLintOpen] = useState(false)
  const [wordFreqOpen, setWordFreqOpen] = useState(false)
  const [docTagsOpen, setDocTagsOpen] = useState(false)
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [cursorLine, setCursorLine] = useState<number | null>(null)
  const [cursorInfo, setCursorInfo] = useState<CursorInfo | null>(null)
  // Portal target for the inline-title; populated by documentTitleHostExtension once the
  // editor view mounts. null in reading view (the editor isn't mounted) and during the
  // transient window between document switch and editor creation.
  const [titleHost, setTitleHost] = useState<HTMLElement | null>(null)
  const titleHostExt = useMemo(
    () => documentTitleHostExtension({
      onHostReady: setTitleHost,
      onHostRelease: () => setTitleHost(null),
    }),
    [],
  )
  const extraExtensions = useMemo(() => [titleHostExt], [titleHostExt])
  const defaultProviders = useVaultSuggestProviders()
  const effectiveProviders = suggestProviders ?? defaultProviders
  const embedLoader = useVaultEmbedLoader()
  const wikilinkResolver = useVaultWikilinkResolver()
  const bookmarked = useIsBookmarked(documentPath)
  const { toggle: toggleBookmark } = useBookmarksActions()
  const { goal: wordGoal, setGoal: setWordGoal } = useWordGoal(documentPath)

  const handleOpenDailyNote = useCallback(async () => {
    const path = await ensureDailyNote()
    onNavigate?.(path)
  }, [onNavigate])

  const handleOpenDailyNoteOffset = useCallback(
    async (offsetDays: number) => {
                                              
      const match = documentPath?.match(/(\d{4})-(\d{2})-(\d{2})\.md$/)
      const base = match
        ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
        : new Date()
      base.setDate(base.getDate() + offsetDays)
      const path = await ensureDailyNoteFor(base)
      onNavigate?.(path)
    },
    [documentPath, onNavigate],
  )

             
  useEffect(() => {
    if (documentPath) pushRecentFile(documentPath)
  }, [documentPath])

            
  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_KEY_OPEN, sideOpen ? '1' : '0')
    } catch {
      /* ignore */
    }
  }, [sideOpen])
  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_KEY_TAB, sideTab)
    } catch {
      /* ignore */
    }
  }, [sideTab])

                                                              
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const container = containerRef.current
      if (!container) return
      if (!container.contains(document.activeElement)) return
      const isPalette = (e.metaKey || e.ctrlKey) && (e.key === 'p' || e.key === 'P')
      if (isPalette) {
        e.preventDefault()
        setPaletteOpen(true)
        return
      }
      const isSwitcher = (e.metaKey || e.ctrlKey) && (e.key === 'o' || e.key === 'O')
      if (isSwitcher) {
        e.preventDefault()
        setSwitcherOpen(true)
        return
      }
      const isGlobalSearch =
        (e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'f' || e.key === 'F')
      if (isGlobalSearch) {
        e.preventDefault()
        setGlobalSearchOpen(true)
        return
      }
      const isDaily = (e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 't' || e.key === 'T')
      if (isDaily) {
        e.preventDefault()
        void handleOpenDailyNote()
        return
      }
      const isDailyPrev = e.altKey && e.shiftKey && e.key === 'ArrowLeft'
      if (isDailyPrev) {
        e.preventDefault()
        void handleOpenDailyNoteOffset(-1)
        return
      }
      const isDailyNext = e.altKey && e.shiftKey && e.key === 'ArrowRight'
      if (isDailyNext) {
        e.preventDefault()
        void handleOpenDailyNoteOffset(1)
        return
      }
      const isReadingView = (e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === 'e' || e.key === 'E')
      if (isReadingView) {
        e.preventDefault()
        onSetReadingView?.(!readingView)
      }
      const isHeadingJump =
        (e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'h' || e.key === 'H')
      if (isHeadingJump) {
        e.preventDefault()
        setHeadingJumpOpen(true)
      }
      const isBlockJump =
        (e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'b' || e.key === 'B')
      if (isBlockJump) {
        e.preventDefault()
        setBlockJumpOpen(true)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [handleOpenDailyNote, handleOpenDailyNoteOffset, readingView, onSetReadingView])

                                
  useEffect(() => {
    const handler = () => {
      const view = editorRef.current?.view
      if (!view) return
      view.dispatch({ selection: { anchor: 0, head: 0 } })
      view.focus()
    }
    window.addEventListener('kition:document:focus-editor', handler)
    return () => window.removeEventListener('kition:document:focus-editor', handler)
  }, [])

  const stats = useMemo(() => {
    const lines = value ? value.split(/\r?\n/).length : 0
    const words = countWords(value)
                                            
    const readingMinutes = Math.max(1, Math.round(words / 250))
    return {
      chars: value.length,
      words,
      lines,
      readingMinutes,
    }
  }, [value])

  const selectionStats = useMemo(() => {
    if (!cursorInfo || cursorInfo.selectionLength === 0) return null
    return {
      chars: cursorInfo.selectionLength,
      words: countWords(cursorInfo.selectionText),
    }
  }, [cursorInfo])

  const headings = useMemo(() => parseOutlineHeadings(value), [value])

  const handleCreateEditor = useCallback((view: EditorView) => {
    setCursorLine(view.state.doc.lineAt(view.state.selection.main.head).number)
  }, [])

  const handleSelectHeading = useCallback((line: number) => {
    const view = editorRef.current?.view
    if (!view) return
    const target = view.state.doc.line(line)
    view.dispatch({
      selection: EditorSelection.cursor(target.from),
      effects: EditorView.scrollIntoView(target.from, { y: 'start' }),
    })
    view.focus()
  }, [])

  const handleSelectTag = useCallback((line: number) => {
    handleSelectHeading(line)
  }, [handleSelectHeading])

  const handleSelectBacklink = useCallback(
    (path: string, line: number) => {
      onNavigate?.(path, { line })
    },
    [onNavigate],
  )

  const handleSelectGlobalTag = useCallback(
    (_name: string) => {
                          
      const view = editorRef.current?.view
      if (!view) return
      view.focus()
    },
    [],
  )

  const handleWikilinkNavigate = useCallback(
    (link: { target: string; heading?: string; blockId?: string }) => {
      const path = wikilinkResolver.resolvePath(link.target, documentPath)
      if (!path) return
      const section = link.heading
        ? `#${link.heading}`
        : link.blockId
          ? `#^${link.blockId}`
          : undefined
      onNavigate?.(path, section ? { section } : undefined)
    },
    [documentPath, wikilinkResolver, onNavigate],
  )

  const handleCreateMissingNote = useCallback(
    async (target: string) => {
      if (!(await confirm(t('document.notFoundCreatePrompt', { target })))) return
      const hasSlash = target.includes('/')
      const hasExt = /\.[a-z0-9]+$/i.test(target)
      let dir = ''
      if (!hasSlash && documentPath) {
        const idx = documentPath.lastIndexOf('/')
        if (idx >= 0) dir = documentPath.slice(0, idx + 1)
      }
      const newPath = (dir + target) + (hasExt ? '' : '.md')
      const existing = wikilinkResolver.resolvePath(target, documentPath)
      if (existing) {
        onNavigate?.(existing)
        return
      }
      const slash = newPath.lastIndexOf('/')
      const base = (slash >= 0 ? newPath.slice(slash + 1) : newPath).replace(/\.md$/i, '')
      try {
        await writeWorkspaceDocument(newPath, `# ${base}\n\n`)
        invalidateVaultWikilinkResolver()
        onNavigate?.(newPath)
      } catch (err) {
        notify.error(t('common.createFailed'), { description: err instanceof Error ? err.message : String(err) })
      }
    },
    [confirm, documentPath, onNavigate, t, wikilinkResolver],
  )

  const handleEmbedNavigate = useCallback(
    (target: string, section?: string) => {
      const path = wikilinkResolver.resolvePath(target, documentPath)
      if (!path) return
      onNavigate?.(path, section ? { section } : undefined)
    },
    [documentPath, onNavigate, wikilinkResolver],
  )

  const handleChange = useCallback(
    (next: string) => {
      onChange(next)
    },
    [onChange],
  )

  const openSideTab = useCallback((tab: SideTab) => {
    setSideTab(tab)
    setSideOpen((open) => (open && sideTab === tab ? false : true))
  }, [sideTab])

  const handleToggleBookmark = useCallback(() => {
    if (!documentPath) return
    toggleBookmark(documentPath)
  }, [documentPath, toggleBookmark])

  const handleEditWordGoal = useCallback(() => {
    if (!documentPath) return
    const current = wordGoal ?? ''
    const input = window.prompt(td('pane.wordGoalPrompt'), String(current))
    if (input === null) return
    if (input.trim() === '') {
      setWordGoal(null)
      return
    }
    const parsed = Number(input.trim())
    if (Number.isFinite(parsed) && parsed > 0) {
      setWordGoal(parsed)
    }
  }, [documentPath, wordGoal, setWordGoal])

  const handleExtractToNote = useCallback(async () => {
    const view = getView()
    if (!view) return
    const main = view.state.selection.main
    if (main.empty) {
      notify.warning(t('kition.document.selectContentToExtract'))
      return
    }
    const selected = view.state.sliceDoc(main.from, main.to)
    if (!selected.trim()) {
      notify.warning(t('kition.document.selectionEmpty'))
      return
    }
                                
    const firstLine = selected.split('\n')[0].trim()
    const cleaned = firstLine.replace(/^#+\s+/, '').replace(/[\[\]<>:"/\\|?*\n]/g, '').slice(0, 80)
    const proposed = cleaned || td('pane.untitledNote')
    const name = window.prompt(td('pane.newNotePrompt'), proposed)
    if (name === null) return
    const trimmed = name.trim()
    if (!trimmed) return
                
    const dir = documentPath?.includes('/')
      ? documentPath.slice(0, documentPath.lastIndexOf('/') + 1)
      : ''
    const newPath = `${dir}${trimmed}.md`
    try {
      const body = `# ${trimmed}\n\n${selected.trim()}\n`
      await writeWorkspaceDocument(newPath, body)
      clearVaultFileCache()
                          
      view.dispatch({
        changes: { from: main.from, to: main.to, insert: `[[${trimmed}]]` },
      })
      onNavigate?.(newPath)
    } catch (err) {
      notify.error(t('kition.document.extractFailed'), { description: (err as Error).message ?? t('common.unknown') })
    }
  }, [documentPath, getView, onNavigate, t])

  const paletteExtras = useMemo<PaletteExtra[]>(() => {
    const list: PaletteExtra[] = []
    list.push({
      id: 'toggle-reading-view',
      group: td('pane.palette.groupView'),
      label: readingView ? td('pane.palette.toggleReading') : td('pane.palette.enterReading'),
      shortcut: '⌘E',
      run: () => onSetReadingView?.(!readingView),
    })
    list.push({
      id: 'toggle-side-outline',
      group: td('pane.palette.groupView'),
      label: sideOpen ? td('pane.palette.closeSidebar') : td('pane.palette.openSidebar'),
      run: () => setSideOpen((v) => !v),
    })
    list.push({
      id: 'open-daily-note',
      group: td('pane.palette.groupView'),
      label: td('pane.palette.openTodayNote'),
      shortcut: '⌘⇧T',
      run: () => void handleOpenDailyNote(),
    })
    list.push({
      id: 'daily-prev',
      group: td('pane.palette.groupView'),
      label: td('pane.palette.openPrevDayNote'),
      shortcut: '⌥⇧←',
      run: () => void handleOpenDailyNoteOffset(-1),
    })
    list.push({
      id: 'daily-next',
      group: td('pane.palette.groupView'),
      label: td('pane.palette.openNextDayNote'),
      shortcut: '⌥⇧→',
      run: () => void handleOpenDailyNoteOffset(1),
    })
    list.push({
      id: 'open-calendar',
      group: td('pane.palette.groupView'),
      label: td('pane.palette.openDailyCalendar'),
      run: () => setCalendarOpen(true),
    })
    list.push({
      id: 'quick-add-daily',
      group: td('pane.palette.groupTools'),
      label: td('pane.palette.appendToToday'),
      run: () => {
        const text = window.prompt(td('pane.appendToTodayPrompt'))
        if (text === null) return
        const trimmed = text.trim()
        if (!trimmed) return
        void (async () => {
          const path = await appendToDailyNote(`- ${trimmed}`)
                              
          void path
        })()
      },
    })
    list.push({
      id: 'open-quick-switch',
      group: td('pane.palette.groupNav'),
      label: td('pane.palette.quickOpen'),
      shortcut: '⌘O',
      run: () => setSwitcherOpen(true),
    })
    list.push({
      id: 'open-global-search',
      group: td('pane.palette.groupNav'),
      label: td('pane.palette.globalSearch'),
      shortcut: '⌘⇧F',
      run: () => setGlobalSearchOpen(true),
    })
    list.push({
      id: 'heading-jump',
      group: td('pane.palette.groupNav'),
      label: td('pane.palette.jumpToHeading'),
      shortcut: '⌘⇧H',
      run: () => setHeadingJumpOpen(true),
    })
    list.push({
      id: 'block-jump',
      group: td('pane.palette.groupNav'),
      label: td('pane.palette.jumpToBlock'),
      shortcut: '⌘⇧B',
      run: () => setBlockJumpOpen(true),
    })
    list.push({
      id: 'random-note',
      group: td('pane.palette.groupNav'),
      label: td('pane.palette.openRandomNote'),
      run: () => {
        void (async () => {
          const path = await pickRandomMarkdownFile(documentPath)
          if (path) onNavigate?.(path)
        })()
      },
    })
    list.push({
      id: 'insert-template',
      group: td('pane.palette.groupTools'),
      label: td('pane.palette.insertTemplate'),
      run: () => setTemplatesOpen(true),
    })
    list.push({
      id: 'extract-to-note',
      group: td('pane.palette.groupTools'),
      label: td('pane.palette.extractSelection'),
      run: () => void handleExtractToNote(),
    })
    list.push({
      id: 'manage-snippets',
      group: td('pane.palette.groupTools'),
      label: td('pane.palette.manageSnippets'),
      run: () => setSnippetsOpen(true),
    })
    list.push({
      id: 'tag-browser',
      group: td('pane.palette.groupTools'),
      label: td('pane.palette.tagBrowser'),
      run: () => setTagBrowserOpen(true),
    })
    list.push({
      id: 'edit-properties',
      group: td('pane.palette.groupTools'),
      label: td('pane.palette.editProperties'),
      run: () => setPropertiesOpen(true),
    })
    list.push({
      id: 'broken-links',
      group: td('pane.palette.groupTools'),
      label: td('pane.palette.checkBrokenLinks'),
      run: () => setBrokenLinksOpen(true),
    })
    list.push({
      id: 'markdown-lint',
      group: td('pane.palette.groupTools'),
      label: 'Markdown Lint…',
      run: () => setLintOpen(true),
    })
    list.push({
      id: 'word-frequency',
      group: td('pane.palette.groupTools'),
      label: td('pane.palette.wordFrequency'),
      run: () => setWordFreqOpen(true),
    })
    list.push({
      id: 'document-tags',
      group: td('pane.palette.groupTools'),
      label: td('pane.palette.documentTags'),
      run: () => setDocTagsOpen(true),
    })
    list.push({
      id: 'heading-outline',
      group: td('pane.palette.groupNav'),
      label: td('pane.palette.headingOutlineTree'),
      run: () => setOutlineOpen(true),
    })
    list.push({
      id: 'copy-section-link',
      group: td('pane.palette.groupTools'),
      label: td('pane.palette.copySectionLink'),
      run: () => {
        const view = editorRef.current?.view
        if (!view) return
        const base = documentPath?.split('/').pop()?.replace(/\.md$/i, '') ?? ''
        const txt = buildSectionLinkText(view, base)
        if (!txt) return
        try {
          void navigator.clipboard?.writeText(txt)
        } catch {
          // best-effort
        }
      },
    })
    list.push({
      id: 'copy-outline-text',
      group: td('pane.palette.groupTools'),
      label: td('pane.palette.copyOutlineToClipboard'),
      run: () => {
        const view = editorRef.current?.view
        if (!view) return
        const txt = exportOutlineToText(view.state.doc.toString())
        if (!txt) return
        try {
          void navigator.clipboard?.writeText(txt)
        } catch {
          // best-effort
        }
      },
    })
    list.push({
      id: 'tasks-aggregator',
      group: td('pane.palette.groupTools'),
      label: td('pane.palette.tasksAggregate'),
      run: () => setTasksOpen(true),
    })
    if (documentPath) {
      list.push({
        id: 'toggle-pin-tab',
        group: td('pane.palette.groupTools'),
        label: isTabPinned(documentPath) ? td('pane.palette.unpinTab') : td('pane.palette.pinTab'),
        run: () => togglePinTab(documentPath),
      })
    }
    list.push({
      id: 'vault-stats',
      group: td('pane.palette.groupTools'),
      label: td('pane.palette.vaultStats'),
      run: () => setVaultStatsOpen(true),
    })
    if (documentPath) {
      list.push({
        id: 'local-graph',
        group: td('pane.palette.groupTools'),
        label: td('pane.palette.localGraph'),
        run: () => setGraphOpen(true),
      })
    }
    if (documentPath) {
      list.push({
        id: 'toggle-bookmark',
        group: td('pane.palette.groupFile'),
        label: bookmarked ? td('pane.palette.unbookmark') : td('pane.palette.bookmark'),
        run: () => handleToggleBookmark(),
      })
      list.push({
        id: 'copy-path',
        group: td('pane.palette.groupFile'),
        label: td('pane.palette.copyPath'),
        run: () => {
          void navigator.clipboard?.writeText(documentPath)
        },
      })
      const basename = documentPath.split('/').pop()?.replace(/\.md$/i, '') ?? documentPath
      list.push({
        id: 'copy-wikilink',
        group: td('pane.palette.groupFile'),
        label: td('pane.palette.copyWikilink'),
        run: () => {
          void navigator.clipboard?.writeText(`[[${basename}]]`)
        },
      })
      list.push({
        id: 'edit-word-goal',
        group: td('pane.palette.groupFile'),
        label: wordGoal ? td('pane.palette.editWordGoal', { goal: wordGoal }) : td('pane.palette.setWordGoal'),
        run: () => handleEditWordGoal(),
      })
    }
    list.push({
      id: 'clear-recents',
      group: td('pane.palette.groupMaint'),
      label: td('pane.palette.clearRecents'),
      run: () => clearRecentFiles(),
    })
    if (documentPath) {
      list.push({
        id: 'copy-block-ref',
        group: td('pane.palette.groupFile'),
        label: td('pane.palette.copyBlockRef'),
        shortcut: '⌘R',
        run: () => {
          const view = getView()
          if (!view) return
          const id = ensureBlockIdAtCursor(view)
          const base = documentPath.replace(/\.md$/i, '')
          void navigator.clipboard?.writeText(`[[${base}#^${id}]]`)
        },
      })
      list.push({
        id: 'copy-heading-link',
        group: td('pane.palette.groupFile'),
        label: td('pane.palette.copyHeadingLink'),
        run: () => {
          const view = getView()
          if (!view) return
          const heading = getHeadingAtCursor(view)
          if (!heading) {
            notify.warning(t('kition.document.notOnHeading'))
            return
          }
          const base = documentPath.replace(/\.md$/i, '')
          void navigator.clipboard?.writeText(`[[${base}#${heading}]]`)
        },
      })
    }
    return list
  }, [
    bookmarked,
    documentPath,
    getView,
    handleEditWordGoal,
    handleExtractToNote,
    handleOpenDailyNote,
    handleOpenDailyNoteOffset,
    handleToggleBookmark,
    onNavigate,
    onSetReadingView,
    readingView,
    sideOpen,
    t,
    wordGoal,
  ])

  return (
    <div ref={containerRef} className="document-editor-pane relative flex h-full min-h-0 flex-col">
      <DocumentEditorToolbar
        getView={getView}
        readOnly={readOnly}
        showTools={settings.display.showDocumentToolbar}
        onToggleOutline={settings.display.showDocumentToolbar ? () => openSideTab('outline') : undefined}
        outlineOpen={sideOpen && sideTab === 'outline'}
        readingView={readingView}
        onSetReadingView={onSetReadingView}
        actionsSlot={
          onToolbarMount ? (
            <span
              ref={onToolbarMount}
              className="document-toolbar-actions-slot ml-1 flex items-center gap-1"
              data-window-drag-exclude="true"
            />
          ) : undefined
        }
      />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <DocumentPinnedTabBar
            currentPath={documentPath}
            onOpen={(path) => onNavigate?.(path)}
          />
          {inlineTitleSlot ? (
            <DocumentTitleHostPortal host={titleHost}>{inlineTitleSlot}</DocumentTitleHostPortal>
          ) : null}
          <div className="min-h-0 min-w-0 flex-1">
            <DocumentEditor
              ref={editorRef}
              value={value}
              readOnly={readOnly || readingView}
              editable={!readingView}
              onChange={handleChange}
              sourcePath={documentPath}
              className="h-full"
              onCreateEditor={handleCreateEditor}
              onCursorLineChange={setCursorLine}
              onCursorChange={setCursorInfo}
              suggestProviders={effectiveProviders}
              resolveWikilink={wikilinkResolver.resolve}
              onWikilinkNavigate={handleWikilinkNavigate}
              onCreateMissingNote={handleCreateMissingNote}
              loadEmbed={embedLoader}
              onEmbedNavigate={handleEmbedNavigate}
              extraExtensions={extraExtensions}
            />
          </div>
        </div>
        {sideOpen ? (
          <aside className="hidden h-full w-72 shrink-0 flex-col border-l border-border/40 bg-muted/20 md:flex">
            <div className="flex shrink-0 items-center gap-0.5 border-b border-border/40 bg-background/60 px-1 py-1">
              <SideTabButton active={sideTab === 'outline'} onClick={() => setSideTab('outline')} label={td('pane.sideTab.outline')} />
              <SideTabButton active={sideTab === 'explorer'} onClick={() => setSideTab('explorer')} label={td('pane.sideTab.explorer')} />
              <SideTabButton active={sideTab === 'backlinks'} onClick={() => setSideTab('backlinks')} label={td('pane.sideTab.backlinks')} />
              <SideTabButton active={sideTab === 'outgoing'} onClick={() => setSideTab('outgoing')} label={td('pane.sideTab.outgoing')} />
              <SideTabButton active={sideTab === 'tags'} onClick={() => setSideTab('tags')} label={td('pane.sideTab.tags')} />
              <SideTabButton active={sideTab === 'recents'} onClick={() => setSideTab('recents')} label={td('pane.sideTab.recents')} />
              <SideTabButton active={sideTab === 'bookmarks'} onClick={() => setSideTab('bookmarks')} label={td('pane.sideTab.bookmarks')} />
              <button
                type="button"
                onClick={() => setSideOpen(false)}
                className="ml-auto rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent/40 hover:text-foreground"
                title={td('pane.closeSidebar')}
              >
                ×
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {sideTab === 'outline' ? (
                <DocumentOutlinePanel
                  source={value}
                  currentLine={cursorLine}
                  onSelect={handleSelectHeading}
                />
              ) : null}
              {sideTab === 'backlinks' ? (
                <DocumentBacklinksPanel
                  currentPath={documentPath}
                  onSelect={handleSelectBacklink}
                />
              ) : null}
              {sideTab === 'outgoing' ? (
                <DocumentOutgoingLinksPanel
                  source={value}
                  currentPath={documentPath}
                  onOpen={(path) => onNavigate?.(path)}
                />
              ) : null}
              {sideTab === 'tags' ? (
                <DocumentTagsPanel
                  source={value}
                  currentPath={documentPath}
                  onSelectInDocument={(t) => handleSelectTag(t.line + 1)}
                  onSelectGlobalTag={handleSelectGlobalTag}
                />
              ) : null}
              {sideTab === 'recents' ? (
                <DocumentRecentsPanel
                  currentPath={documentPath}
                  onOpen={(path) => onNavigate?.(path)}
                />
              ) : null}
              {sideTab === 'bookmarks' ? (
                <DocumentBookmarksPanel
                  currentPath={documentPath}
                  onOpen={(path) => onNavigate?.(path)}
                />
              ) : null}
              {sideTab === 'explorer' ? (
                <DocumentExplorerPanel
                  currentPath={documentPath}
                  onOpen={(path) => onNavigate?.(path)}
                />
              ) : null}
            </div>
          </aside>
        ) : null}
      </div>
      <div className="document-editor-status flex items-center justify-between gap-4 border-t border-border/40 px-3 py-1 text-[11px] text-muted-foreground">
        <div className="flex min-w-0 items-center gap-3">
          {cursorInfo ? (
            <span className="whitespace-nowrap tabular-nums">
              {td('pane.cursorPosition', { line: cursorInfo.line, col: cursorInfo.col })}
            </span>
          ) : null}
          {selectionStats ? (
            <span className="whitespace-nowrap tabular-nums">
              {td('pane.selectionStats', { chars: selectionStats.chars, words: selectionStats.words })}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-4">
          <span className="whitespace-nowrap tabular-nums">{td('pane.statsWords', { count: stats.words })}</span>
          <span className="whitespace-nowrap tabular-nums">{td('pane.statsChars', { count: stats.chars })}</span>
          <span className="whitespace-nowrap tabular-nums">{td('pane.statsLines', { count: stats.lines })}</span>
          <span className="whitespace-nowrap tabular-nums">{td('pane.statsReadingMinutes', { minutes: stats.readingMinutes })}</span>
        </div>
      </div>
      <DocumentCommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        getView={getView}
        extras={paletteExtras}
      />
      <DocumentQuickSwitcher
        open={switcherOpen}
        onOpenChange={setSwitcherOpen}
        currentPath={documentPath}
        onOpen={(path) => onNavigate?.(path)}
      />
      <DocumentGlobalSearch
        open={globalSearchOpen}
        onOpenChange={setGlobalSearchOpen}
        onOpen={(path, line) => onNavigate?.(path, { line })}
      />
      <DocumentTemplatesPicker
        open={templatesOpen}
        onOpenChange={setTemplatesOpen}
        getView={getView}
        currentPath={documentPath}
      />
      <DocumentVaultStatsDialog
        open={vaultStatsOpen}
        onOpenChange={setVaultStatsOpen}
      />
      {documentPath ? (
        <DocumentLocalGraphDialog
          open={graphOpen}
          onOpenChange={setGraphOpen}
          currentPath={documentPath}
          onOpen={(path) => onNavigate?.(path)}
        />
      ) : null}
      <DocumentDailyCalendar
        open={calendarOpen}
        onOpenChange={setCalendarOpen}
        onOpen={(path) => onNavigate?.(path)}
      />
      <DocumentSnippetsDialog
        open={snippetsOpen}
        onOpenChange={setSnippetsOpen}
      />
      <DocumentTagBrowserDialog
        open={tagBrowserOpen}
        onOpenChange={setTagBrowserOpen}
        onOpen={(path) => onNavigate?.(path)}
      />
      <DocumentPropertiesDialog
        open={propertiesOpen}
        onOpenChange={setPropertiesOpen}
        source={value}
        onApply={onChange}
      />
      <DocumentBrokenLinksDialog
        open={brokenLinksOpen}
        onOpenChange={setBrokenLinksOpen}
        onOpen={(path, line) => onNavigate?.(path, { line })}
      />
      <DocumentTasksDialog
        open={tasksOpen}
        onOpenChange={setTasksOpen}
        onOpen={(path, line) => onNavigate?.(path, { line })}
      />
      <DocumentHeadingJumpDialog
        open={headingJumpOpen}
        onOpenChange={setHeadingJumpOpen}
        getView={getView}
      />
      <DocumentBlockJumpDialog
        open={blockJumpOpen}
        onOpenChange={setBlockJumpOpen}
        getView={getView}
      />
      <DocumentMarkdownLintDialog
        open={lintOpen}
        onOpenChange={setLintOpen}
        source={value}
        getView={getView}
      />
      <DocumentWordFrequencyDialog
        open={wordFreqOpen}
        onOpenChange={setWordFreqOpen}
        source={value}
        getView={getView}
      />
      <DocumentTagsDialog
        open={docTagsOpen}
        onOpenChange={setDocTagsOpen}
        source={value}
        getView={getView}
      />
      <DocumentHeadingOutlineDialog
        open={outlineOpen}
        onOpenChange={setOutlineOpen}
        source={value}
        getView={getView}
      />
    </div>
  )
}, (prev, next) =>
  prev.documentPath === next.documentPath
  && prev.readOnly === next.readOnly
  && prev.value === next.value
  && prev.inlineTitleSlot === next.inlineTitleSlot
  && prev.onToolbarMount === next.onToolbarMount
  && prev.readingView === next.readingView
  && prev.onSetReadingView === next.onSetReadingView
  && prev.onNavigate === next.onNavigate
  && prev.onChange === next.onChange
  && prev.suggestProviders === next.suggestProviders)

function SideTabButton({
  active,
  onClick,
  label,
}: {
  active: boolean
  onClick: () => void
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded px-2 py-0.5 text-[12px] transition',
        active
          ? 'bg-accent/60 text-foreground'
          : 'text-muted-foreground hover:bg-accent/30 hover:text-foreground',
      )}
    >
      {label}
    </button>
  )
}
