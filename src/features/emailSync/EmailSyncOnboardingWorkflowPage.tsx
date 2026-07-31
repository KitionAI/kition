import { Mail, Settings2 } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui'
import { NodeCard } from '@/features/workflow/canvas/NodeCard'
import { WorkflowCanvas } from '@/features/workflow/canvas/WorkflowCanvas'
import { PropertiesDrawer } from '@/features/workflow/drawer/PropertiesDrawer'
import type { EmailSyncWorkflow } from './api'
import { EmailSyncTriggerPanel } from './EmailSyncTriggerPanel'
import { EmailSyncWorkflowEditor } from './EmailSyncWorkflowEditor'

export function EmailSyncOnboardingWorkflowPage({
  tablePath,
  onSaved,
  runAfterSave,
}: {
  tablePath: string
  onSaved: (workflow: EmailSyncWorkflow) => void
  runAfterSave?: 'full'
}) {
  const [activePanel, setActivePanel] = useState<'trigger' | 'action' | null>(null)
  const [schedule, setSchedule] = useState({ enabled: true, intervalMinutes: 15 })

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background pt-12"
      data-testid="email-sync-onboarding-workflow-page"
    >
      <header className="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-border px-6">
        <div className="flex min-w-0 items-center gap-3">
          <Mail className="size-4 text-primary" />
          <h1 className="truncate text-base font-semibold text-foreground">Sync email inbox</h1>
          <span className="rounded-md bg-warning/10 px-2 py-1 text-xs font-medium text-warning-foreground">
            Setup required
          </span>
        </div>
        <Button size="sm" onClick={() => setActivePanel('action')}>
          <Settings2 className="size-4" />
          Configure email
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 p-4">
          <WorkflowCanvas key={activePanel ? 'drawer-open' : 'drawer-closed'} disabled>
            <NodeCard
              kind="trigger"
              rowLabel="Step 1 · Trigger"
              title={schedule.enabled ? 'Scheduled trigger' : 'Manual trigger'}
              description={schedule.enabled
                ? `Every ${schedule.intervalMinutes} minutes`
                : 'Run manually from the workflow'}
              status={schedule.enabled ? 'green' : 'muted'}
              selected={activePanel === 'trigger'}
              dataRole="trigger"
              onSelect={() => setActivePanel('trigger')}
            />
            <NodeCard
              kind="action"
              rowLabel="Step 2 · Email"
              title="Sync email inbox"
              description={`Import messages into ${tableName(tablePath)}`}
              status="amber"
              selected={activePanel === 'action'}
              dataRole="action"
              onSelect={() => setActivePanel('action')}
              extra={(
                <div className="text-[11px] text-warning-foreground">
                  Connect an email account to activate this step.
                </div>
              )}
            />
          </WorkflowCanvas>
        </main>

        <PropertiesDrawer
          open={activePanel !== null}
          kind={activePanel === 'trigger' ? 'Trigger' : 'Action'}
          title={activePanel === 'trigger' ? 'Start this workflow' : 'Sync email inbox'}
          onClose={() => setActivePanel(null)}
        >
          {activePanel === 'trigger' ? (
            <EmailSyncTriggerPanel
              enabled={schedule.enabled}
              intervalMinutes={schedule.intervalMinutes}
              onSave={(enabled, intervalMinutes) => {
                setSchedule({ enabled, intervalMinutes })
                setActivePanel(null)
              }}
            />
          ) : activePanel === 'action' ? (
            <EmailSyncWorkflowEditor
              layout="panel"
              showSchedule={false}
              enableByDefault={schedule.enabled}
              defaultIntervalMinutes={schedule.intervalMinutes}
              tablePath={tablePath}
              runAfterSave={runAfterSave}
              onCancel={() => setActivePanel(null)}
              onSaved={onSaved}
            />
          ) : null}
        </PropertiesDrawer>
      </div>
    </div>
  )
}

function tableName(path: string) {
  return path.split(/[\\/]/).pop()?.replace(/\.kitable$/i, '') || 'Inbox'
}
