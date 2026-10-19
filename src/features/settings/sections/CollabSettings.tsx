import { useEffect, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { Button, Input } from '@kition/app-ui'
import { Switch } from '@kition/app-ui/switch'
import {
  refreshAccountSettings,
  requestSyncedDocuments,
  setSyncAllDocuments,
  setSyncServerUrl,
  syncServerUrl,
  testSyncServer,
  useCollabConnectionState,
  useSyncAllDocuments,
  type SyncServerTest,
} from '@/features/collab/public'
import { SettingsPaneHeader, SettingsRow, SettingsSection } from '@/features/settings/primitives'
import { useTranslation } from '@/i18n'
import { cn } from '@kition/app-ui/utils'

/**
 * Co-editing: the sync server this window connects to (empty: co-editing is off), whether it is
 * connected, and a one-off test of a server; the URL connects nothing unless the person tests it.
 * Syncing across their devices: "Sync all my documents" (an account setting on the server, off by
 * default, which this pane reads when a server is set, connecting to it), and the list of synced
 * documents not in this workspace yet.
 */
export function CollabSettings() {
  const { t } = useTranslation('settings')
  const state = useCollabConnectionState()
  const [saved, setSaved] = useState(() => syncServerUrl())
  const [draft, setDraft] = useState(saved)
  const [test, setTest] = useState<{ busy: boolean; result: SyncServerTest | null }>({ busy: false, result: null })
  const syncAll = useSyncAllDocuments()
  const [syncAllState, setSyncAllState] = useState<{ busy: boolean; failed: boolean; loaded: boolean }>({ busy: false, failed: false, loaded: false })
  const dirty = draft.trim() !== saved
  const status = saved ? (state === 'off' ? 'offline' : state) : 'off'

  const save = () => {
    setSyncServerUrl(draft)
    const next = syncServerUrl()
    setSaved(next)
    setDraft(next)
  }

  useEffect(() => {
    if (!saved) return
    let live = true
    void refreshAccountSettings().then(
      () => live && setSyncAllState((current) => ({ ...current, loaded: true })),
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [saved])

  const changeSyncAll = (on: boolean) => {
    setSyncAllState({ busy: true, failed: false, loaded: true })
    void setSyncAllDocuments(on).then(
      () => setSyncAllState({ busy: false, failed: false, loaded: true }),
      () => setSyncAllState({ busy: false, failed: true, loaded: true }),
    )
  }

  const runTest = () => {
    setTest({ busy: true, result: null })
    void testSyncServer(draft).then((result) => setTest({ busy: false, result }))
  }

  return (
    <div className="settings-pane" data-testid="collab-settings">
      <SettingsPaneHeader title={t('collab.paneTitle')} description={t('collab.paneDescription')} />
      <SettingsSection title={t('collab.serverSection')}>
        <SettingsRow title={t('collab.serverUrlTitle')} description={t('collab.serverUrlDescription')}>
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              if (dirty) save()
            }}
          >
            <Input
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value)
                setTest({ busy: false, result: null })
              }}
              placeholder={t('collab.serverUrlPlaceholder')}
              aria-label={t('collab.serverUrlTitle')}
              className="w-72"
              spellCheck={false}
              data-testid="collab-server-url"
            />
            <Button type="submit" size="sm" disabled={!dirty} data-testid="collab-server-save">
              {t('collab.save')}
            </Button>
          </form>
        </SettingsRow>
        <SettingsRow title={t('collab.statusTitle')} description={t(`collab.statusDescription.${status}`)}>
          <span className={cn('collab-status', `is-${status}`)} role="status" aria-label={t(`collab.status.${status}`)} data-testid="collab-settings-status" data-state={status} />
          <span className="text-sm text-muted-foreground">{t(`collab.status.${status}`)}</span>
        </SettingsRow>
        <SettingsRow title={t('collab.testTitle')} description={test.result ? t(`collab.testResult.${test.result}`) : t('collab.testDescription')}>
          <Button type="button" variant="outline" size="sm" disabled={!draft.trim() || test.busy} onClick={runTest} data-testid="collab-server-test" data-result={test.result ?? undefined}>
            {test.busy ? <LoaderCircle className="size-4 animate-spin" /> : null}
            {t('collab.test')}
          </Button>
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title={t('collab.devicesSection')}>
        <SettingsRow
          title={t('collab.syncAllTitle')}
          description={syncAllState.failed ? t('collab.syncAllFailed') : saved ? t('collab.syncAllDescription') : t('collab.syncAllOffline')}
        >
          <Switch
            checked={syncAll}
            disabled={!saved || !syncAllState.loaded || syncAllState.busy}
            onCheckedChange={changeSyncAll}
            aria-label={t('collab.syncAllTitle')}
            data-testid="collab-sync-all"
          />
        </SettingsRow>
        <SettingsRow title={t('collab.syncedTitle')} description={t('collab.syncedDescription')}>
          <Button type="button" variant="outline" size="sm" disabled={!saved} onClick={requestSyncedDocuments} data-testid="collab-synced-show">
            {t('collab.syncedShow')}
          </Button>
        </SettingsRow>
      </SettingsSection>
    </div>
  )
}
