import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui'
import { openExternalURL } from '@/services/desktop'
import { checkForUpdates, downloadUpdate, installUpdate } from '@/services/desktopUpdates'
import { dismissVersion, isVersionDismissed } from './dismissedVersion'
import { useUpdateState } from './useUpdateState'

const RELEASES_BASE = 'https://github.com/KitionAI/kition/releases/tag'

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB'
  const mb = bytes / (1024 * 1024)
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`
}

function useUpdateBannerVisibilityFlag(visible: boolean) {
  useEffect(() => {
    if (typeof document === 'undefined') return
    const root = document.documentElement
    if (visible) {
      root.dataset.updateBanner = '1'
      return () => {
        delete root.dataset.updateBanner
      }
    }
    delete root.dataset.updateBanner
    return undefined
  }, [visible])
}

export function UpdateBanner() {
  const { t } = useTranslation(['settings', 'common'])
  const state = useUpdateState()
  const [tick, setTick] = useState(0)

  const phase = state.phase
  const dismissed =
    phase === 'available' && isVersionDismissed((state as any).version)
  const visible =
    phase !== 'idle' &&
    phase !== 'checking' &&
    phase !== 'up-to-date' &&
    phase !== 'unsupported' &&
    !dismissed
  useUpdateBannerVisibilityFlag(visible)

  if (!visible) {
    return null
  }

  void tick

  if (phase === 'available') {
    const version = (state as any).version as string | undefined
    return (
      <div className="kition-update-banner kition-update-banner--info" role="status">
        <span>{version ? t('updates.availableVersion', { version }) : t('updates.availableGeneric')}</span>
        {version ? (
          <Button variant="ghost" size="sm" onClick={() => void openExternalURL(`${RELEASES_BASE}/v${version}`)}>
            {t('updates.viewReleaseNotes')}
          </Button>
        ) : null}
        <Button variant="default" size="sm" onClick={() => void downloadUpdate()}>{t('updates.download')}</Button>
        <Button variant="ghost" size="sm" onClick={() => { if (version) dismissVersion(version); setTick((n) => n + 1) }}>
          {t('updates.later')}
        </Button>
      </div>
    )
  }

  if (phase === 'downloading') {
    const s = state as Extract<typeof state, { phase: 'downloading' }>
    return (
      <div className="kition-update-banner kition-update-banner--info" role="status">
        <span>{t('updates.downloadingProgress', { percent: Math.round(s.percent) })}</span>
        <span className="kition-update-banner__progress">
          <span style={{ width: `${Math.round(s.percent)}%` }} />
        </span>
        <span className="kition-update-banner__meta">
          {formatBytes(s.transferred)} / {formatBytes(s.total)}
        </span>
      </div>
    )
  }

  if (phase === 'downloaded') {
    const s = state as Extract<typeof state, { phase: 'downloaded' }>
    return (
      <div className="kition-update-banner kition-update-banner--success" role="status">
        <span>{t('updates.readyToInstall', { version: s.version })}</span>
        <Button variant="default" size="sm" onClick={() => void installUpdate()}>{t('updates.restartAndInstall')}</Button>
      </div>
    )
  }

  if (phase === 'error') {
    const s = state as Extract<typeof state, { phase: 'error' }>
    const copy =
      s.errorKind === 'network' ? t('updates.errorNetwork') :
      s.errorKind === 'verification' ? t('updates.errorVerification') :
      s.errorKind === 'disk' ? t('updates.errorDisk') :
      s.errorKind === 'rate-limit' ? t('updates.errorRateLimit') :
      s.message
    return (
      <div className="kition-update-banner kition-update-banner--error" role="alert">
        <span>{copy}</span>
        <Button variant="default" size="sm" onClick={() => void checkForUpdates()}>{t('common:actions.retry')}</Button>
      </div>
    )
  }

  return null
}
