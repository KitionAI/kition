import { MailIcon as Mail, Settings2Icon as Settings2 } from '@kition/tessera-icons/react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@kition/tessera'
import { NodeCard } from '@/features/workflow/canvas/NodeCard'
import { WorkflowCanvas } from '@/features/workflow/canvas/WorkflowCanvas'
import { PropertiesDrawer } from '@/features/workflow/drawer/PropertiesDrawer'
import type { EmailSyncWorkflow } from '@/api/emailSync'
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
  const { t } = useTranslation('workflow')
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
          <h1 className="truncate text-base font-semibold text-foreground">{t('emailInboxSetup.title')}</h1>
          <span className="rounded-md bg-warning/10 px-2 py-1 text-xs font-medium text-warning-foreground">
            {t('emailInboxSetup.setupRequired')}
          </span>
        </div>
        <Button variant="primary" size="sm" onClick={() => setActivePanel('action')}>
          <Settings2 className="size-4" />
          {t('emailInboxSetup.configureEmail')}
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 p-4">
          <WorkflowCanvas key={activePanel ? 'drawer-open' : 'drawer-closed'} disabled>
            <NodeCard
              kind="trigger"
              rowLabel={t('emailInboxSetup.triggerStep')}
              title={schedule.enabled ? t('emailInboxSetup.scheduledTrigger') : t('emailInboxSetup.manualTrigger')}
              description={schedule.enabled
                ? t('emailInboxSetup.everyMinutes', { count: schedule.intervalMinutes })
                : t('emailInboxSetup.runManually')}
              status={schedule.enabled ? 'green' : 'muted'}
              selected={activePanel === 'trigger'}
              dataRole="trigger"
              onSelect={() => setActivePanel('trigger')}
            />
            <NodeCard
              kind="action"
              rowLabel={t('emailInboxSetup.emailStep')}
              title={t('emailInboxSetup.title')}
              description={t('emailInboxSetup.importInto', { table: tableName(tablePath) || t('emailInboxSetup.defaultTable') })}
              status="amber"
              selected={activePanel === 'action'}
              dataRole="action"
              onSelect={() => setActivePanel('action')}
              extra={(
                <div className="text-[11px] text-warning-foreground">
                  {t('emailInboxSetup.connectAccount')}
                </div>
              )}
            />
          </WorkflowCanvas>
        </main>

        <PropertiesDrawer
          open={activePanel !== null}
          kind={activePanel === 'trigger' ? 'Trigger' : 'Action'}
          title={activePanel === 'trigger' ? t('emailInboxSetup.startWorkflow') : t('emailInboxSetup.title')}
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
  return path.split(/[\\/]/).pop()?.replace(/\.ktable$/i, '') || ''
}
