import { ChevronDown, ChevronLeft, ChevronRight, FileSpreadsheet, FileText, FileVideo2, Globe, Image as ImageIcon, LayoutDashboard, PanelLeftOpen, X, Zap } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { WorkspaceTabContextMenu, type WorkspaceTabContextMenuItem } from '@/features/workspace/components/WorkspaceTabContextMenu'
import { findLinkedWorkspaceTabIds } from '@/features/workspace/lib/browserTabs'
import { getWorkspaceItemIcon, getWorkspaceItemIconColorClass, type WorkspaceTab } from '@/features/workspace/lib/workspace'
import { cn } from '@/lib/utils'

export function WorkspaceTabStrip({
  tabs,
  activeTabId,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseAll,
  onCloseUnmodified,
  onCloseLeft,
  onCloseRight,
  onCloseReadOnly,
  onCopyTabRef,
  isTabModified,
  sidebarCollapsed,
  onToggleSidebar,
}: {
  tabs: WorkspaceTab[]
  activeTabId: string
  onActivate: (tab: WorkspaceTab) => Promise<void> | void
  onClose: (tabId: string) => void
  onCloseOthers?: (tabId: string) => void
  onCloseAll?: () => void
  onCloseUnmodified?: () => void
  onCloseLeft?: (tabId: string) => void
  onCloseRight?: (tabId: string) => void
  onCloseReadOnly?: () => void
  onCopyTabRef?: (tab: WorkspaceTab) => void
  isTabModified?: (tab: WorkspaceTab) => boolean
  sidebarCollapsed?: boolean
  onToggleSidebar?: () => void
}) {
  const [contextMenu, setContextMenu] = useState<{ tabId: string; x: number; y: number } | null>(null)
  const { t } = useTranslation('workspace')
  const barRef = useRef<HTMLDivElement | null>(null)
  const navRef = useRef<HTMLDivElement | null>(null)
  const measureTabRefs = useRef(new Map<string, HTMLDivElement>())
  const [visibleTabIds, setVisibleTabIds] = useState<string[]>(() => tabs.map((tab) => tab.id))
  const [overflowOpen, setOverflowOpen] = useState(false)

  useEffect(() => {
    let animationFrame = 0

    function commitVisibleTabIds(nextIds: string[]) {
      setVisibleTabIds((currentIds) => (
        currentIds.length === nextIds.length && currentIds.every((id, index) => id === nextIds[index])
          ? currentIds
          : nextIds
      ))
    }

    function measureTabs() {
      const bar = barRef.current
      if (!bar || !tabs.length) {
        commitVisibleTabIds([])
        return
      }

      const gap = 4
      const horizontalPadding = 24
      const overflowTriggerWidth = 40
      // The leading nav buttons (collapse sidebar / prev / next) consume horizontal
      // space that must be deducted from the available width. Otherwise capacity is
      // overestimated and the rightmost (usually active) tab gets clipped.
      const navWidth = navRef.current?.offsetWidth || 0
      const availableWidth = Math.max(0, bar.clientWidth - navWidth - horizontalPadding)
      const tabWidths = new Map(tabs.map((tab) => [tab.id, measureTabRefs.current.get(tab.id)?.offsetWidth || 160]))
      const totalWidth = tabs.reduce((sum, tab, index) => sum + (index > 0 ? gap : 0) + (tabWidths.get(tab.id) || 160), 0)

      if (totalWidth <= availableWidth) {
        commitVisibleTabIds(tabs.map((tab) => tab.id))
        setOverflowOpen(false)
        return
      }

      const activeId = tabs.some((tab) => tab.id === activeTabId) ? activeTabId : tabs[0]?.id
      const linkedIds = findLinkedWorkspaceTabIds(tabs, activeId)
      const nextVisibleIds = new Set<string>()
      let usedWidth = 0
      const foldedAvailableWidth = Math.max(0, availableWidth - overflowTriggerWidth)

      function addTab(tabId: string, force = false) {
        if (!tabId || nextVisibleIds.has(tabId)) {
          return
        }

        const width = tabWidths.get(tabId) || 160
        const nextWidth = usedWidth + (nextVisibleIds.size ? gap : 0) + width
        if (!force && nextWidth > foldedAvailableWidth) {
          return
        }

        nextVisibleIds.add(tabId)
        usedWidth = nextWidth
      }

      addTab(activeId, true)
      linkedIds.forEach((tabId) => addTab(tabId, true))
                                             
                                                    
      for (let i = tabs.length - 1; i >= 0; i--) {
        addTab(tabs[i].id)
      }

      const orderedVisibleIds = tabs.filter((tab) => nextVisibleIds.has(tab.id)).map((tab) => tab.id)
      commitVisibleTabIds(orderedVisibleIds)
      if (orderedVisibleIds.length === tabs.length) {
        setOverflowOpen(false)
      }
    }

    function scheduleMeasure() {
      window.cancelAnimationFrame(animationFrame)
      animationFrame = window.requestAnimationFrame(measureTabs)
    }

    scheduleMeasure()
    const resizeObserver = new ResizeObserver(scheduleMeasure)
    if (barRef.current) {
      resizeObserver.observe(barRef.current)
    }
    window.addEventListener('resize', scheduleMeasure)

    return () => {
      window.cancelAnimationFrame(animationFrame)
      resizeObserver.disconnect()
      window.removeEventListener('resize', scheduleMeasure)
    }
  }, [activeTabId, tabs])

  useEffect(() => {
    if (!overflowOpen) {
      return
    }

    function handlePointerDown(event: MouseEvent) {
      if (!barRef.current?.contains(event.target as Node)) {
        setOverflowOpen(false)
      }
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOverflowOpen(false)
      }
    }

    window.addEventListener('mousedown', handlePointerDown)
    window.addEventListener('keydown', handleEscape)

    return () => {
      window.removeEventListener('mousedown', handlePointerDown)
      window.removeEventListener('keydown', handleEscape)
    }
  }, [overflowOpen])

  const visibleTabIdSet = useMemo(
    () => new Set(visibleTabIds.length ? visibleTabIds : tabs.map((tab) => tab.id)),
    [tabs, visibleTabIds],
  )
  const linkedTabIdSet = useMemo(
    () => new Set(findLinkedWorkspaceTabIds(tabs, activeTabId)),
    [activeTabId, tabs],
  )
  const visibleTabs = tabs.filter((tab) => visibleTabIdSet.has(tab.id))
  const overflowTabs = tabs.filter((tab) => !visibleTabIdSet.has(tab.id))

  function activateTab(tab: WorkspaceTab) {
    setOverflowOpen(false)
    void onActivate(tab)
  }

  function openContextMenu(event: React.MouseEvent, tabId: string) {
    event.preventDefault()
    event.stopPropagation()
    setOverflowOpen(false)
    setContextMenu({ tabId, x: event.clientX, y: event.clientY })
  }

  function buildContextMenuItems(tabId: string): WorkspaceTabContextMenuItem[] {
    const tab = tabs.find((item) => item.id === tabId)
    if (!tab) {
      return []
    }
    const index = tabs.findIndex((item) => item.id === tabId)
    const hasLeft = index > 0
    const hasRight = index >= 0 && index < tabs.length - 1
    const hasOthers = tabs.length > 1
    const supportsCopyRef = tab.type === 'document' || tab.type === 'file-viewer' || tab.type === 'browser'
    return [
      {
        key: 'close',
        label: t('tabs.close'),
        shortcut: '⌘W',
        onSelect: () => onClose(tabId),
      },
      {
        key: 'close-others',
        label: t('tabs.closeOthers'),
        disabled: !hasOthers || !onCloseOthers,
        onSelect: () => onCloseOthers?.(tabId),
      },
      {
        key: 'close-all',
        label: t('tabs.closeAll'),
        disabled: !tabs.length || !onCloseAll,
        onSelect: () => onCloseAll?.(),
      },
      {
        key: 'close-unmodified',
        label: t('tabs.closeUnmodified'),
        disabled: !onCloseUnmodified,
        onSelect: () => onCloseUnmodified?.(),
      },
      {
        key: 'close-left',
        label: t('tabs.closeLeft'),
        disabled: !hasLeft || !onCloseLeft,
        onSelect: () => onCloseLeft?.(tabId),
      },
      {
        key: 'close-right',
        label: t('tabs.closeRight'),
        disabled: !hasRight || !onCloseRight,
        onSelect: () => onCloseRight?.(tabId),
      },
      {
        key: 'close-readonly',
        label: t('tabs.closeReadOnly'),
        disabled: !onCloseReadOnly,
        onSelect: () => onCloseReadOnly?.(),
      },
      { key: 'sep', label: '', separator: true },
      {
        key: 'copy-ref',
        label: t('tabs.copyReference'),
        disabled: !supportsCopyRef || !onCopyTabRef,
        onSelect: () => onCopyTabRef?.(tab),
      },
    ]
  }

  const activeIndex = tabs.findIndex((tab) => tab.id === activeTabId)
  const prevTab = activeIndex > 0 ? tabs[activeIndex - 1] : undefined
  const nextTab = activeIndex >= 0 && activeIndex < tabs.length - 1 ? tabs[activeIndex + 1] : undefined

  function renderTab(tab: WorkspaceTab) {
    return (
      <div
        key={tab.id}
        className={cn(
          'document-tab',
          tab.type === 'browser' && 'is-browser',
          linkedTabIdSet.has(tab.id) && 'is-linked',
          activeTabId === tab.id && 'is-active',
          isTabModified?.(tab) && 'is-modified',
        )}
        title={tab.title}
        data-tab-title={tab.title}
        onClick={() => activateTab(tab)}
        onContextMenu={(event) => openContextMenu(event, tab.id)}
        role="button"
        tabIndex={0}
        aria-current={activeTabId === tab.id ? 'page' : undefined}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            activateTab(tab)
          }
        }}
      >
        <WorkspaceTabIcon tab={tab} />
        {tab.type === 'browser' ? (
          <span className="document-tab-badge">{t('tabs.webBadge')}</span>
        ) : null}
        <span>{tab.title}</span>
        <button
          type="button"
          className="document-tab-close"
          onClick={(event) => {
            event.stopPropagation()
            onClose(tab.id)
          }}
          aria-label={t('tabs.closeTab')}
        >
          <X className="size-3" />
        </button>
      </div>
    )
  }

  return (
    <div className="document-tab-bar" ref={barRef}>
      <div className="document-tab-nav" ref={navRef}>
        {onToggleSidebar && sidebarCollapsed ? (
          <button
            type="button"
            className="document-tab-nav-btn"
            onClick={onToggleSidebar}
            aria-label={t('tabs.expandSidebar')}
            title={t('tabs.expandSidebar')}
          >
            <PanelLeftOpen className="size-4" />
          </button>
        ) : null}
        <button
          type="button"
          className="document-tab-nav-btn"
          onClick={() => prevTab && activateTab(prevTab)}
          disabled={!prevTab}
          aria-label={t('tabs.previousTab')}
          title={t('tabs.previousTab')}
        >
          <ChevronLeft className="size-4" />
        </button>
        <button
          type="button"
          className="document-tab-nav-btn"
          onClick={() => nextTab && activateTab(nextTab)}
          disabled={!nextTab}
          aria-label={t('tabs.nextTab')}
          title={t('tabs.nextTab')}
        >
          <ChevronRight className="size-4" />
        </button>
      </div>
      <div className="document-tab-list">
        {visibleTabs.map(renderTab)}
      </div>
      {overflowTabs.length ? (
        <div className="document-tab-overflow">
          <button
            type="button"
            className={cn('document-tab-overflow-trigger', overflowOpen && 'is-active')}
            onClick={() => setOverflowOpen((open) => !open)}
            aria-label={t('tabs.showOverflow')}
            aria-expanded={overflowOpen}
          >
            <ChevronDown className="size-4" />
          </button>
          {overflowOpen ? (
            <div className="document-tab-overflow-menu">
              {overflowTabs.map((tab) => (
                <div
                  key={tab.id}
                  className={cn(
                    'document-tab-overflow-item',
                    tab.type === 'browser' && 'is-browser',
                    linkedTabIdSet.has(tab.id) && 'is-linked',
                    activeTabId === tab.id && 'is-active',
                    isTabModified?.(tab) && 'is-modified',
                  )}
                  title={tab.title}
                  data-tab-title={tab.title}
                  onClick={() => activateTab(tab)}
                  onContextMenu={(event) => openContextMenu(event, tab.id)}
                  role="button"
                  tabIndex={0}
                  aria-current={activeTabId === tab.id ? 'page' : undefined}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      activateTab(tab)
                    }
                  }}
                >
                  <WorkspaceTabIcon tab={tab} />
                  {tab.type === 'browser' ? (
                    <span className="document-tab-badge">{t('tabs.webBadge')}</span>
                  ) : null}
                  <span>{tab.title}</span>
                  <button
                    type="button"
                    className="document-tab-close"
                    onClick={(event) => {
                      event.stopPropagation()
                      onClose(tab.id)
                    }}
                    aria-label={t('tabs.closeTab')}
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="document-tab-measure" aria-hidden="true">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            ref={(node) => {
              if (node) {
                measureTabRefs.current.set(tab.id, node)
              } else {
                measureTabRefs.current.delete(tab.id)
              }
            }}
            className="document-tab"
          >
            <WorkspaceTabIcon tab={tab} />
            {tab.type === 'browser' ? (
              <span className="document-tab-badge">{t('tabs.webBadge')}</span>
            ) : null}
            <span>{tab.title}</span>
            <button type="button" className="document-tab-close" tabIndex={-1}>
              <X className="size-3" />
            </button>
          </div>
        ))}
      </div>
      {contextMenu ? (
        <WorkspaceTabContextMenu
          position={{ x: contextMenu.x, y: contextMenu.y }}
          items={buildContextMenuItems(contextMenu.tabId)}
          onClose={() => setContextMenu(null)}
        />
      ) : null}
    </div>
  )
}

function WorkspaceTabIcon({ tab }: { tab: WorkspaceTab }) {
  if (tab.type === 'browser') {
    return <Globe className="size-3.5" />
  }
  if (tab.type === 'browser-sites') {
    return <Globe className="size-3.5" />
  }
  if (tab.type === 'gallery') {
    return tab.kind === 'images'
      ? <ImageIcon className={cn('size-3.5', getWorkspaceItemIconColorClass('image'))} />
      : <FileVideo2 className={cn('size-3.5', getWorkspaceItemIconColorClass('video'))} />
  }
  if (tab.type === 'file-viewer') {
    const Icon = getWorkspaceItemIcon(tab.format)
    return <Icon className={cn('size-3.5', getWorkspaceItemIconColorClass(tab.format))} />
  }
  if (tab.type === 'workflow') {
    if (tab.kitablePath) {
      return <FileSpreadsheet className={cn('size-3.5', getWorkspaceItemIconColorClass('data'))} />
    }
    return <Zap className="size-3.5 text-brand" />
  }
  if (tab.type === 'dashboard') {
    return <LayoutDashboard className="size-3.5 text-brand" />
  }
  return tab.format === 'data'
    ? <FileSpreadsheet className={cn('size-3.5', getWorkspaceItemIconColorClass('data'))} />
    : <FileText className={cn('size-3.5', getWorkspaceItemIconColorClass(tab.format))} />
}
