import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, MessageSquare } from 'lucide-react'

import { BuildProgressCard } from '@/features/agent/components/BuildProgressCard'
import { RightDrawer } from '@/components/RightDrawer'
import { TableEditor } from '@/features/table/components/TableEditor'
import type { DataRecordValue } from '@/types/dataDocument'
import type {
  ScenarioBuildEvent,
  ScenarioBuildStatus,
} from '@/features/scenario/types'

export interface ScenarioBuildPageProps {
  events: ScenarioBuildEvent[]
  status: ScenarioBuildStatus
  baseId: string | null
  baseName: string | null
  error: string | null
  /** Called when the user wants to exit the build page and go back. */
  onClose: () => void
}

/**
 * Layout shown once a scenario build is in flight (or finished). The left
 * "central area" mounts the live `TableEditor` (Task 10) once both
 * `base.created` and `table.created` events have landed, and forwards
 * every subsequent `cell.ai.filled` event to it as an append-only patch
 * list so newly extracted cells flip from the AI placeholder to the real
 * value without any manual refresh.
 *
 * Drawer semantics (PRD §3.2):
 *   - Slide in from the right (200ms ease-out) — handled by RightDrawer's CSS
 *     transition.
 *   - Default width 380px, drag-resizable on the left edge, can be closed via
 *     the × button.
 *   - Once closed, a "Show chat" button in the central area re-opens it. We do
 *     NOT auto-reopen the drawer on new events — only the user's intent.
 */
export function ScenarioBuildPage({
  events,
  status,
  baseId,
  baseName,
  error,
  onClose,
}: ScenarioBuildPageProps) {
  const { t } = useTranslation(['settings', 'common'])
  const [drawerOpen, setDrawerOpen] = useState(true)
  const [drawerWidth, setDrawerWidth] = useState(380)

  const progressTitle = baseName ?? t('scenario.buildingBase')

  // Derive the tableId from the first `table.created` event in the
  // stream so we know when it's safe to mount TableEditor (and tell
  // it which marker payload to resolve).
  const tableId = useMemo<string | null>(() => {
    for (const event of events) {
      if (event.kind === 'table.created') return event.tableId
    }
    return null
  }, [events])

  // Project the events stream down to just the cell-fill patches. This
  // is what TableEditor consumes via its append-only `aiCellPatches`
  // prop; events in any other order are filtered out so we don't have
  // to think about kind discrimination inside the hook.
  const aiCellPatches = useMemo(() => {
    const out: Array<{ recordId: number; fieldId: number; value: DataRecordValue }> =
      []
    for (const event of events) {
      if (event.kind !== 'cell.ai.filled') continue
      out.push({
        recordId: event.recordId,
        fieldId: event.fieldId,
        value: event.value as DataRecordValue,
      })
    }
    return out
  }, [events])

  return (
    <div
      data-testid="scenario-build-page"
      className="relative flex min-h-screen w-full bg-background"
    >
      {/* Central area — leaves room for the drawer on the right when open */}
      <main
        data-testid="scenario-build-central"
        className="flex flex-1 flex-col items-stretch px-6 py-6"
        style={{ marginRight: drawerOpen ? `${drawerWidth}px` : 0 }}
      >
        <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-6">
          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              data-testid="scenario-build-leave"
              onClick={onClose}
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label={t('scenario.backToStart')}
            >
              <ArrowLeft className="size-4" />
              <span>{t('scenario.back')}</span>
            </button>
            {!drawerOpen ? (
              <button
                type="button"
                data-testid="scenario-build-show-chat"
                onClick={() => setDrawerOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-sm text-foreground shadow-soft hover:bg-muted"
              >
                <MessageSquare className="size-4" />
                <span>{t('scenario.showChat')}</span>
              </button>
            ) : null}
          </div>

          <ScenarioBuildCentralContent
            status={status}
            baseName={baseName}
            baseId={baseId}
            tableId={tableId}
            aiCellPatches={aiCellPatches}
            error={error}
          />
        </div>
      </main>

      <RightDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={drawerWidth}
        onResize={setDrawerWidth}
        title={progressTitle}
      >
        <BuildProgressCard events={events} title={progressTitle} />
      </RightDrawer>
    </div>
  )
}

function ScenarioBuildCentralContent({
  status,
  baseName,
  baseId,
  tableId,
  aiCellPatches,
  error,
}: {
  status: ScenarioBuildStatus
  baseName: string | null
  baseId: string | null
  tableId: string | null
  aiCellPatches: ReadonlyArray<{
    recordId: number
    fieldId: number
    value: DataRecordValue
  }>
  error: string | null
}) {
  const { t } = useTranslation('settings')
  if (status === 'error') {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        <p className="font-medium">{t('scenario.buildFailed')}</p>
        <p className="mt-1 break-words">{error ?? t('scenario.unknownError')}</p>
      </div>
    )
  }

  // Once we have both the base (= DataDocument) and the first table,
  // mount the live editor. The synthetic `scenario:<baseId>` document
  // path is a sentinel — TableEditor's data hook short-circuits to
  // `getDataDocument(<baseId>)` via the marker payload, so the path
  // never hits the workspace filesystem.
  if (baseId && tableId) {
    const numericBaseId = Number(baseId)
    if (Number.isFinite(numericBaseId) && numericBaseId > 0) {
      return (
        <TableEditor
          documentPath={`scenario:${baseId}`}
          markerContent={JSON.stringify({ data_document_id: numericBaseId })}
          aiCellPatches={aiCellPatches}
        />
      )
    }
  }

  if (status === 'done') {
    return (
      <div className="rounded-lg border border-border bg-muted p-4 text-sm text-foreground">
        <p className="font-medium">{t('scenario.done')}</p>
        <p className="mt-1">
          {baseName ? t('scenario.baseReadyNamed', { name: baseName }) : t('scenario.baseReady')}
        </p>
      </div>
    )
  }

  if (baseId) {
    return (
      <div className="rounded-lg border border-border bg-muted p-4 text-sm text-foreground">
        <p className="font-medium">
          {baseName ? t('scenario.buildingBaseNamed', { name: baseName }) : t('scenario.buildingBase')}
        </p>
        <p className="mt-1 text-muted-foreground">
          {t('scenario.tableWillAppear')}
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-border bg-muted p-4 text-sm text-foreground">
      <p className="font-medium">{t('scenario.workingOnScenario')}</p>
      <p className="mt-1 text-muted-foreground">
        {t('scenario.hangTight')}
      </p>
    </div>
  )
}
