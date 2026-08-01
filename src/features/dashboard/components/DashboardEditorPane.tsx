import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'

import { LayoutDashboard, Lock, RefreshCw, Unlock } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Responsive,
  WidthProvider,
  type Layout,
  type ResponsiveLayouts,
} from 'react-grid-layout/legacy'

import { listDataRecords } from '@/api/dataDocuments'
import { openDataDashboardByPath, updateDataDashboard } from '@/api/dashboards'
import { DashboardWidgetCard } from '@/features/dashboard/components/DashboardWidgetCard'
import { executeDashboardWidgetQuery } from '@/features/dashboard/lib/dashboardQuery'
import { Button } from '@/registry/ui/button'
import type {
  DashboardLayoutItem,
  DataDashboard,
  DataDocument,
  DataRecord,
  DataTable,
} from '@/types/dataDocument'

const ResponsiveDashboardGrid = WidthProvider(Responsive)
type DashboardBreakpoint = 'lg' | 'md' | 'sm' | 'xs' | 'xxs'

export function DashboardEditorPane({
  dashboardId,
  documentPath,
}: {
  dashboardId: string
  documentPath: string
}) {
  const [dashboard, setDashboard] = useState<DataDashboard | null>(null)
  const [document, setDocument] = useState<DataDocument | null>(null)
  const [records, setRecords] = useState<DataRecord[]>([])
  const [sourceTable, setSourceTable] = useState<DataTable | null>(null)
  const [editing, setEditing] = useState(false)
  const [breakpoint, setBreakpoint] = useState<DashboardBreakpoint>('lg')
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const [savingLayout, setSavingLayout] = useState(false)

  const load = useCallback(async () => {
    setPhase('loading')
    setError('')
    try {
      const opened = await openDataDashboardByPath(documentPath, dashboardId)
      const table = opened.document.tables?.find(
        (item) => item.id === opened.dashboard.source_table_id,
      ) || null
      if (!table) throw new Error('Dashboard source table not found')
      const result = await listDataRecords(opened.document.id, table.id, { limit: 500, offset: 0 })
      setDocument(opened.document)
      setDashboard(opened.dashboard)
      setSourceTable(table)
      setRecords(result.items || [])
      setPhase('ready')
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Dashboard failed to load')
      setPhase('error')
    }
  }, [dashboardId, documentPath])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    function handleRecordChange(event: Event) {
      const detail = (event as CustomEvent<{
        vaultPath?: string
        tableId?: number
      }>).detail
      if (detail?.vaultPath !== documentPath || detail.tableId !== sourceTable?.id) return
      void load()
    }
    window.addEventListener('kition:data-document:record:upsert', handleRecordChange)
    window.addEventListener('kition:data-document:record:delete', handleRecordChange)
    return () => {
      window.removeEventListener('kition:data-document:record:upsert', handleRecordChange)
      window.removeEventListener('kition:data-document:record:delete', handleRecordChange)
    }
  }, [documentPath, load, sourceTable?.id])

  const widgetResults = useMemo(() => {
    const results = new Map<string, ReturnType<typeof executeDashboardWidgetQuery>>()
    if (!dashboard || !sourceTable) return results
    dashboard.widgets.forEach((widget) => {
      results.set(widget.id, executeDashboardWidgetQuery(widget, records, sourceTable.fields || []))
    })
    return results
  }, [dashboard, records, sourceTable])

  const layouts = useMemo<ResponsiveLayouts<DashboardBreakpoint>>(() => {
    const desktop = toGridLayout(dashboard?.layout || [])
    const compact = toSingleColumnLayout(dashboard?.layout || [])
    return { lg: desktop, md: desktop, sm: desktop, xs: compact, xxs: compact }
  }, [dashboard?.layout])

  const smallScreen = breakpoint === 'xs' || breakpoint === 'xxs'
  const layoutEditing = editing && !smallScreen

  const persistLayout = useCallback((layout: Layout) => {
    if (!dashboard || !document || smallScreen) return
    const nextDashboard: DataDashboard = {
      ...dashboard,
      layout: layout.map((item) => ({
        widget_id: item.i,
        x: item.x,
        y: item.y,
        w: item.w,
        h: item.h,
        ...(item.minW != null ? { min_w: item.minW } : {}),
        ...(item.minH != null ? { min_h: item.minH } : {}),
      })),
    }
    setDashboard(nextDashboard)
    setSavingLayout(true)
    void updateDataDashboard(document, nextDashboard)
      .then((updated) => {
        setDocument(updated.document)
        setDashboard(updated.dashboard)
      })
      .catch((saveError) => {
        setError(saveError instanceof Error ? saveError.message : 'Dashboard layout could not be saved')
      })
      .finally(() => setSavingLayout(false))
  }, [dashboard, document, smallScreen])

  if (phase === 'loading') {
    return (
      <div className="flex h-full items-center justify-center bg-muted/30" role="status">
        <span className="workspace-browser-tab__spinner" aria-hidden="true" />
        <span className="sr-only">Loading dashboard</span>
      </div>
    )
  }

  if (phase === 'error' || !dashboard || !sourceTable) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-muted/30 p-8 text-center">
        <LayoutDashboard className="size-9 text-muted-foreground" />
        <div>
          <h1 className="text-base font-semibold text-foreground">Dashboard unavailable</h1>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">{error || 'Dashboard not found'}</p>
        </div>
        <Button variant="outline" size="md" onClick={() => void load()}>
          <RefreshCw />
          Try again
        </Button>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-muted/30" data-testid="dashboard-editor-pane">
      <header className="dashboard-editor-topbar flex min-h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-5 py-3">
        <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <LayoutDashboard className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold text-foreground">{dashboard.title}</h1>
          <p className="truncate text-xs text-muted-foreground">
            Live from {sourceTable.title} · {records.length.toLocaleString()} records
          </p>
        </div>
        {savingLayout ? <span className="text-xs text-muted-foreground">Saving layout…</span> : null}
        <Button variant="outline" size="md" onClick={() => void load()}>
          <RefreshCw />
          Refresh
        </Button>
        <Button
          variant={layoutEditing ? 'default' : 'outline'}
          size="md"
          disabled={smallScreen}
          title={smallScreen ? 'Layout editing is available on wider screens' : undefined}
          onClick={() => setEditing((current) => !current)}
        >
          {layoutEditing ? <Unlock /> : <Lock />}
          {layoutEditing ? 'Finish layout' : 'Customize layout'}
        </Button>
      </header>
      {error ? (
        <div className="border-b border-destructive/20 bg-destructive/5 px-5 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto">
        <ResponsiveDashboardGrid
          className="dashboard-grid"
          layouts={layouts}
          breakpoints={{ lg: 1200, md: 996, sm: 768, xs: 480, xxs: 0 }}
          cols={{ lg: 12, md: 12, sm: 12, xs: 1, xxs: 1 }}
          rowHeight={80}
          margin={[16, 16]}
          containerPadding={[20, 20]}
          compactType="vertical"
          draggableHandle=".dashboard-drag-handle"
          isDraggable={layoutEditing}
          isResizable={layoutEditing}
          onBreakpointChange={(nextBreakpoint) => setBreakpoint(nextBreakpoint as DashboardBreakpoint)}
          onDragStop={(layout) => persistLayout(layout)}
          onResizeStop={(layout) => persistLayout(layout)}
        >
          {dashboard.layout.map((item) => {
            const widget = dashboard.widgets.find((candidate) => candidate.id === item.widget_id)
            const result = widget ? widgetResults.get(widget.id) : undefined
            if (!widget || !result) return null
            return (
              <div key={widget.id} data-grid={toGridItem(item)}>
                <DashboardWidgetCard editing={layoutEditing} result={result} widget={widget} />
              </div>
            )
          })}
        </ResponsiveDashboardGrid>
      </div>
    </div>
  )
}

function toGridLayout(layout: DashboardLayoutItem[]): Layout {
  return layout.map(toGridItem)
}

function toGridItem(item: DashboardLayoutItem) {
  return {
    i: item.widget_id,
    x: item.x,
    y: item.y,
    w: item.w,
    h: item.h,
    minW: item.min_w,
    minH: item.min_h,
  }
}

function toSingleColumnLayout(layout: DashboardLayoutItem[]): Layout {
  let nextY = 0
  return layout.map((item) => {
    const next = {
      i: item.widget_id,
      x: 0,
      y: nextY,
      w: 1,
      h: item.h,
      minW: 1,
      minH: item.min_h,
    }
    nextY += item.h
    return next
  })
}
