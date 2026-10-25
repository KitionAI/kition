import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DownloadIcon as Download, LoaderCircleIcon as Loader2, RefreshCwIcon as RefreshCw, TriangleAlertIcon as TriangleAlert } from '@kition/tessera-icons/react'
import { Button } from '@kition/app-ui/button'
import { useDocumentSchemaNotice } from '@/services/documentSchema'
import { checkForUpdates, downloadUpdate, installUpdate, type UpdateState } from '@/services/desktopUpdates'

/**
 * The notice above a co-edited document a newer kit edited (Kit Standard 2.0 rules M5a and M20,
 * `@/services/documentSchema`): it says so, says whether the document stays read-only meanwhile,
 * names the kit version this Kition ships against the schema the document needs, and offers the
 * update (kits ship inside Kition, so updating Kition updates the kit).
 */
export function DocumentSchemaBanner({ path, kitName, kitVersion }: { path: string; kitName: string; kitVersion?: string | null }) {
  const { t } = useTranslation('workspace')
  const notice = useDocumentSchemaNotice(path)
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const [busy, setBusy] = useState(false)
  if (!notice) return null
  const known = Number.isFinite(notice.needs) && Number.isFinite(notice.reads)
  const check = async () => {
    setBusy(true)
    try {
      setUpdate(await checkForUpdates())
    } catch (error) {
      setUpdate({ phase: 'error', message: error instanceof Error ? error.message : String(error), errorKind: 'other', phaseAtError: 'checking' })
    } finally {
      setBusy(false)
    }
  }
  const install = async () => {
    setBusy(true)
    try {
      await downloadUpdate()
      await installUpdate()
    } catch (error) {
      setUpdate({ phase: 'error', message: error instanceof Error ? error.message : String(error), errorKind: 'other', phaseAtError: 'downloading' })
    } finally {
      setBusy(false)
    }
  }
  const outcome =
    update?.phase === 'available'
      ? t('documentSchema.updateAvailable', { version: update.version ?? '' })
      : update?.phase === 'up-to-date'
        ? t('documentSchema.upToDate', { kit: kitName })
        : update?.phase === 'unsupported'
          ? t('documentSchema.updateElsewhere')
          : update?.phase === 'error'
            ? t('documentSchema.updateFailed', { message: update.message })
            : null
  return (
    <div className="document-revision-toolbar document-schema-banner" data-testid="document-schema-banner" data-blocked={notice.blocked ? 'true' : 'false'} role="region" aria-label={t('documentSchema.label')}>
      <div className="document-revision-toolbar__summary">
        <span className="document-revision-toolbar__icon" aria-hidden="true">
          <TriangleAlert />
        </span>
        <span className="min-w-0">
          <strong>{t('documentSchema.title', { kit: kitName })}</strong>
          <span>{notice.blocked ? t('documentSchema.blockedHint') : t('documentSchema.newerHint')}</span>
          {known ? <span data-testid="document-schema-versions">{kitVersion ? t('documentSchema.versions', { kit: kitName, version: kitVersion, reads: notice.reads, needs: notice.needs }) : t('documentSchema.versionsNoKit', { reads: notice.reads, needs: notice.needs })}</span> : null}
          {outcome ? <span data-testid="document-schema-update-outcome">{outcome}</span> : null}
        </span>
      </div>
      <div className="document-revision-toolbar__actions">
        {update?.phase === 'available' ? (
          <Button variant="default" size="md" type="button" disabled={busy} onClick={() => void install()} data-testid="document-schema-install">
            {busy ? <Loader2 className="animate-spin" /> : <Download />}
            {t('documentSchema.install')}
          </Button>
        ) : (
          <Button variant="default" size="md" type="button" disabled={busy} onClick={() => void check()} data-testid="document-schema-check">
            {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            {t('documentSchema.check')}
          </Button>
        )}
      </div>
    </div>
  )
}
