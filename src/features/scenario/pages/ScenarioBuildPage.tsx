import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeftIcon as ArrowLeft, MessageSquareIcon as MessageSquare } from '@kition/tessera-icons/react'

import { BuildProgressCard } from '@/features/agent/components/BuildProgressCard'
import { RightDrawer } from '@/components/RightDrawer'
import { KitFrame } from '@/features/kits/public'
import type {
  ScenarioBuildEvent,
  ScenarioBuildStatus,
} from '@/features/scenario/types'

export interface ScenarioBuildPageProps {
  events: ScenarioBuildEvent[]
  status: ScenarioBuildStatus
  basePath: string | null
  baseName: string | null
  error: string | null
  /** Called when the user wants to exit the build page and go back. */
  onClose: () => void
}

/** The Table kit's package, which shows the new table file. */
const TABLE_KIT = { kitId: 'kit.table', dir: 'table-ui' }

/**
 * Layout shown once a scenario build is in flight (or finished). The left
 * "central area" opens the new table file in the Table kit once both
 * `base.created` and `table.created` events have landed; the runtime writes
 * the AI-filled cells through the kit, so they appear in the open editor live.
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
  basePath,
  baseName,
  error,
  onClose,
}: ScenarioBuildPageProps) {
  const { t } = useTranslation(['settings', 'common'])
  const [drawerOpen, setDrawerOpen] = useState(true)
  const [drawerWidth, setDrawerWidth] = useState(380)

  const progressTitle = baseName ?? t('scenario.buildingBase')

  // Derive the tableId from the first `table.created` event in the
  // stream so we know when the table can be shown.
  const tableId = useMemo<string | null>(() => {
    for (const event of events) {
      if (event.kind === 'table.created') return event.tableId
    }
    return null
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
            basePath={basePath}
            tableId={tableId}
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
  basePath,
  tableId,
  error,
}: {
  status: ScenarioBuildStatus
  baseName: string | null
  basePath: string | null
  tableId: string | null
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

  // Once the table file and its table exist, show them in the Table kit.
  if (basePath && tableId) {
    return (
      <div className="h-[70vh] min-h-[420px] overflow-hidden rounded-xl border border-border" data-testid="scenario-build-table">
        <KitFrame kit={TABLE_KIT} path={basePath} active />
      </div>
    )
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

  if (basePath) {
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
