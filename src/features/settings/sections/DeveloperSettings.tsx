import { useEffect, useState } from 'react'
import { createDefaultDesktopSettings, loadDesktopSettings, saveDesktopSettings } from '@/services/desktopSettings'
import type { DesktopSettingsState } from '@/types/desktopSettings'
import { ProductAnalyticsInspector } from '@/features/analytics/public'
import { SettingsPaneHeader, SettingsSection, SettingsRow, SettingsActionBar } from '@/features/settings/primitives'
import { useTranslation } from '@/i18n'
import { cn } from '@/lib/utils'

export function DeveloperSettings() {
  const { t } = useTranslation('settings')
  const [settings, setSettings] = useState<DesktopSettingsState>(createDefaultDesktopSettings())
  const [pristine, setPristine] = useState<DesktopSettingsState>(createDefaultDesktopSettings())
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null)

  useEffect(() => {
    let mounted = true
    loadDesktopSettings()
      .then((value) => {
        if (!mounted) return
        setSettings(value)
        setPristine(value)
      })
      .finally(() => {
        if (mounted) setLoading(false)
      })
    return () => {
      mounted = false
    }
  }, [])

  async function handleSave() {
    setSaving(true)
    setFeedback('')
    try {
      const saved = await saveDesktopSettings(settings)
      setSettings(saved)
      setPristine(saved)
      setLastSavedAt(Date.now())
    } catch (error: any) {
      setFeedback(error?.message || t('common.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="settings-pane">
        <SettingsPaneHeader title={t('developer.paneTitle')} description={t('developer.paneDescription')} />
        <div className="settings-pane-loading">{t('developer.loading')}</div>
      </div>
    )
  }

  return (
    <div className="settings-pane">
      <SettingsPaneHeader title={t('developer.paneTitle')} description={t('developer.paneDescription')} />
      <SettingsSection title={t('developer.debugSection')}>
        <SettingsRow title={t('developer.debugTitle')} description={t('developer.debugDescription')}>
          <span className={cn('el-switch', settings.general.debug && 'is-checked')}>
            <button
              type="button"
              role="switch"
              aria-checked={settings.general.debug}
              className="settings-switch-button"
              aria-label={t('developer.debugTitle')}
              onClick={() => {
                setFeedback('')
                setSettings((current) => ({
                  ...current,
                  general: { ...current.general, debug: !current.general.debug },
                }))
              }}
            >
              {settings.general.debug ? t('common.enabled') : t('common.disabled')}
            </button>
          </span>
        </SettingsRow>
      </SettingsSection>
      {__APP_BUILD_IDENTITY__ === 'dev' ? <ProductAnalyticsInspector /> : null}
      <SettingsActionBar
        dirty={settings.general.debug !== pristine.general.debug}
        saving={saving}
        onSave={() => void handleSave()}
        onCancel={() => {
          setSettings(pristine)
          setFeedback('')
        }}
        lastSavedAt={lastSavedAt}
      />
      {feedback ? <div className="settings-feedback">{feedback}</div> : null}
    </div>
  )
}
