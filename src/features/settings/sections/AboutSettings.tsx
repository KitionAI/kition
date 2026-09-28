import { useEffect, useState } from 'react'
import type { TFunction } from 'i18next'
import { openExternalURL } from '@/services/desktop'
import { createDefaultDesktopSettings, loadDesktopSettings, saveDesktopSettings } from '@/services/desktopSettings'
import { checkForUpdates, downloadUpdate, installUpdate, setAutoCheckUpdates, setBetaChannel, type UpdateState } from '@/services/desktopUpdates'
import { useUpdateState } from '@/features/updates/public'
import { UpdateDownloadProgress } from '@/features/updates/public'
import type { DesktopSettingsState } from '@/types/desktopSettings'
import { Button } from '@/components/ui'
import { SupportAndTrustSettings } from '@/features/support/public'
import { SettingsPaneHeader, SettingsSection, SettingsRow } from '@/features/settings/primitives'
import { getCurrentLocale, useTranslation } from '@/i18n'

function formatBuildTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return date.toLocaleString(getCurrentLocale(), { hour12: false })
}

const GITHUB_REPO_URL = 'https://github.com/KitionAI/kition'

export function AboutSettings() {
  const { t } = useTranslation('settings')
  const updateState = useUpdateState()
  const [settings, setSettings] = useState<DesktopSettingsState>(createDefaultDesktopSettings())
  const [lastCheckedAt, setLastCheckedAt] = useState<Date | null>(null)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState('')

  useEffect(() => {
    let mounted = true
    loadDesktopSettings()
      .then((value) => {
        if (mounted) {
          setSettings(value)
        }
      })
      .catch(() => {})
    return () => {
      mounted = false
    }
  }, [])

  async function persistSettings(next: DesktopSettingsState) {
    setSettings(next)
    try {
      const saved = await saveDesktopSettings(next)
      setSettings(saved)
    } catch (error: any) {
      setFeedback(error?.message || t('about.saveFailed'))
    }
  }

  async function handleManualCheck() {
    setBusy(true)
    setFeedback('')
    try {
      await checkForUpdates()
      setLastCheckedAt(new Date())
    } catch (error: any) {
      setFeedback(error?.message || t('about.update.checkFailed'))
    } finally {
      setBusy(false)
    }
  }

  async function handleDownload() {
    setBusy(true)
    setFeedback('')
    try {
      await downloadUpdate()
    } catch (error: any) {
      setFeedback(error?.message || t('about.update.downloadFailed'))
    } finally {
      setBusy(false)
    }
  }

  async function handleInstall() {
    setBusy(true)
    setFeedback('')
    try {
      await installUpdate()
    } catch (error: any) {
      setFeedback(error?.message || t('about.update.installFailed'))
      setBusy(false)
    }
  }

  async function handleToggleBeta(next: boolean) {
    await persistSettings({
      ...settings,
      general: { ...settings.general, updateBetaChannel: next },
    })
    try {
      await setBetaChannel(next)
    } catch (error: any) {
      setFeedback(error?.message || t('about.update.channelFailed'))
    }
  }

  async function handleToggleAutoCheck(next: boolean) {
    await persistSettings({
      ...settings,
      general: { ...settings.general, autoCheckUpdates: next },
    })
    try {
      await setAutoCheckUpdates(next)
    } catch (error: any) {
      setFeedback(error?.message || t('about.update.autoCheckFailed'))
    }
  }

  return (
    <div className="settings-pane">
      <SettingsPaneHeader title={t('about.paneTitle')} description={t('about.paneDescription')} />
      <SettingsSection title={t('about.buildSection')}>
        <SettingsRow
          title={t('about.appName')}
          description={t('about.buildInfo', { version: __APP_VERSION__, commit: __APP_COMMIT__, builtAt: formatBuildTime(__APP_BUILD_AT__) })}
        />
        <SettingsRow title={t('about.updates')} description={renderUpdateDescription(t, updateState, lastCheckedAt)}>
          {renderUpdateAction(t, updateState, { busy, onCheck: handleManualCheck, onDownload: handleDownload, onInstall: handleInstall })}
        </SettingsRow>
        <SettingsRow
          title={t('about.autoCheck')}
          description={t('about.autoCheckDescription')}
        >
          <input
            type="checkbox"
            checked={settings.general.autoCheckUpdates}
            onChange={(e) => void handleToggleAutoCheck(e.target.checked)}
            aria-label={t('about.autoCheckAria')}
          />
        </SettingsRow>
        <SettingsRow
          title={t('about.betaChannel')}
          description={t('about.betaChannelDescription')}
        >
          <input
            type="checkbox"
            checked={settings.general.updateBetaChannel}
            onChange={(e) => void handleToggleBeta(e.target.checked)}
            aria-label={t('about.betaChannelAria')}
          />
        </SettingsRow>
      </SettingsSection>
      <SupportAndTrustSettings
        appVersion={__APP_VERSION__}
        appCommit={__APP_COMMIT__}
        buildIdentity={__APP_BUILD_IDENTITY__}
        builtAt={__APP_BUILD_AT__}
        updateState={updateState}
      />
      <SettingsSection title={t('about.linksSection')}>
        <SettingsRow title={t('about.sourceCode')} description={t('about.sourceCodeDescription')}>
          <Button variant="outline" className="w-40" onClick={() => void openExternalURL(GITHUB_REPO_URL)}>{t('about.openGitHub')}</Button>
        </SettingsRow>
        <SettingsRow title={t('about.reportIssue')} description={t('about.reportIssueDescription')}>
          <Button variant="outline" className="w-40" onClick={() => void openExternalURL(`${GITHUB_REPO_URL}/issues`)}>{t('about.openIssues')}</Button>
        </SettingsRow>
        <SettingsRow title={t('about.license')} description={t('about.licenseDescription')}>
          <Button variant="outline" className="w-40" onClick={() => void openExternalURL(`${GITHUB_REPO_URL}/blob/main/LICENSE`)}>{t('about.viewLicense')}</Button>
        </SettingsRow>
      </SettingsSection>
      {feedback ? <div className="settings-feedback">{feedback}</div> : null}
    </div>
  )
}

function renderUpdateDescription(t: TFunction, state: UpdateState, lastCheckedAt: Date | null): string {
  switch (state.phase) {
    case 'unsupported':
      return state.reason === 'dev build'
        ? t('about.update.unsupportedDev')
        : t('about.update.unsupported')
    case 'checking':
      return t('about.update.checking')
    case 'available':
      return t('about.update.available', { version: state.version ?? '?' })
    case 'downloading':
      return t('about.update.downloading', { percent: Math.round(state.percent) })
    case 'downloaded':
      return t('about.update.downloaded', { version: state.version ?? '?' })
    case 'error':
      if (state.errorKind === 'network') return t('updates.errorNetwork')
      if (state.errorKind === 'verification') return t('updates.errorVerification')
      if (state.errorKind === 'disk') return t('updates.errorDisk')
      if (state.errorKind === 'rate-limit') return t('updates.errorRateLimit')
      return state.phaseAtError === 'downloading'
        ? t('about.update.downloadFailed')
        : t('about.update.checkFailed')
    case 'up-to-date':
    case 'idle':
    default:
      return lastCheckedAt
        ? t('about.update.upToDateChecked', { time: lastCheckedAt.toLocaleString() })
        : t('about.update.upToDate')
  }
}

function renderUpdateAction(
  t: TFunction,
  state: UpdateState,
  { busy, onCheck, onDownload, onInstall }: { busy: boolean; onCheck: () => void; onDownload: () => void; onInstall: () => void },
) {
  switch (state.phase) {
    case 'checking':
      return <Button variant="outline" disabled>{t('about.update.actionChecking')}</Button>
    case 'available':
      return <Button variant="default" disabled={busy} onClick={onDownload}>{t('about.update.actionDownload', { version: state.version ?? '?' })}</Button>
    case 'downloading':
      return (
        <UpdateDownloadProgress
          state={state}
          label={t('about.update.downloading', { percent: Math.round(state.percent) })}
        />
      )
    case 'downloaded':
      return <Button variant="default" disabled={busy} onClick={onInstall}>{t('about.update.actionInstall')}</Button>
    case 'error':
      return <Button variant="outline" disabled={busy} onClick={onCheck}>{t('about.update.actionRetry')}</Button>
    case 'unsupported':
      return null
    default:
      return <Button variant="outline" disabled={busy} onClick={onCheck}>{t('about.update.actionCheck')}</Button>
  }
}
