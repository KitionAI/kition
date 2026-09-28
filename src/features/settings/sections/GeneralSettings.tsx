import { normalizeTranslationTargetPreference, TRANSLATION_LANGUAGES, translationLanguageEndonym } from '@/lib/translationLanguages'
import { useEffect, useState } from 'react'
import { openExternalURL } from '@/services/desktop'
import { createDefaultDesktopSettings, loadDesktopSettings, saveDesktopSettings } from '@/services/desktopSettings'
import type { DesktopSettingsState } from '@/types/desktopSettings'
import { Button, Select } from '@/components/ui'
import { OnboardingGuidesPanel } from '@/features/settings/OnboardingGuidesPanel'
import { KITION_PRIVACY_URL } from '@/features/account/public'
import { SettingsPaneHeader, SettingsSection, SettingsRow, SettingsActionBar } from '@/features/settings/primitives'
import { isPristine } from '@/features/settings/dirty'
import { getLocaleEndonym, setCurrentLocale, SUPPORTED_LOCALES, useTranslation, type Locale } from '@/i18n'
import { cn } from '@/lib/utils'
import { ShieldCheck } from 'lucide-react'
import { preserveLiveThemePreview } from '@/features/settings/sections/themePreview'

type GeneralToggleField = {
  [K in keyof DesktopSettingsState['general']]: DesktopSettingsState['general'][K] extends boolean ? K : never
}[keyof DesktopSettingsState['general']]

const generalToggleFields: ReadonlyArray<{ field: GeneralToggleField; titleKey: string; descriptionKey?: string }> = [
  { field: 'restoreWorkspaceOnLaunch', titleKey: 'general.restoreWorkspaceOnLaunch' },
  { field: 'confirmBeforeQuit', titleKey: 'general.confirmBeforeQuit' },
  { field: 'autoCheckUpdates', titleKey: 'general.autoCheckUpdates' },
]

export function GeneralSettings() {
  const { t } = useTranslation('settings')
  const [settings, setSettings] = useState<DesktopSettingsState>(createDefaultDesktopSettings())
  const [pristine, setPristine] = useState<DesktopSettingsState>(createDefaultDesktopSettings())
  const [feedback, setFeedback] = useState('')
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [gettingStartedGuidesOpen, setGettingStartedGuidesOpen] = useState(false)
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null)

  useEffect(() => {
    let mounted = true
    loadDesktopSettings()
      .then((value) => {
        if (mounted) {
          setSettings(value)
          setPristine(value)
        }
      })
      .finally(() => {
        if (mounted) {
          setLoading(false)
        }
      })
    return () => {
      mounted = false
    }
  }, [])

  function updateGeneral(patch: Partial<DesktopSettingsState['general']>) {
    setFeedback('')
    setSettings((current) => ({
      ...current,
      general: {
        ...current.general,
        ...patch,
      },
    }))
  }

  function updateLanguage(value: Locale) {
    updateGeneral({ language: value })
    setCurrentLocale(value)
  }

  async function handleSave() {
    setSaving(true)
    try {
      const saved = await saveDesktopSettings(preserveLiveThemePreview(settings))
      setSettings(saved)
      setPristine(saved)
      setFeedback(t('common.saved'))
      setLastSavedAt(Date.now())
    } catch (error: any) {
      setFeedback(error?.message || t('common.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  function handleCancel() {
    setSettings(pristine)
    setCurrentLocale(pristine.general.language)
    setFeedback('')
  }

  if (loading) {
    return (
      <div className="settings-pane">
        <SettingsPaneHeader title={t('general.paneTitle')} description={t('general.paneDescription')} />
        <div className="settings-pane-loading">{t('general.loading')}</div>
      </div>
    )
  }

  return (
    <div className="settings-pane">
      <SettingsPaneHeader title={t('general.paneTitle')} description={t('general.paneDescription')} />
      <SettingsSection title={t('language.label')}>
        <SettingsRow title={t('language.label')} description={t('language.description')}>
          <Select
            className="settings-select w-full max-w-[220px]"
            value={settings.general.language}
            onChange={(event) => updateLanguage(event.target.value as Locale)}
            aria-label={t('language.label')}
          >
            {SUPPORTED_LOCALES.map((locale) => (
              <option key={locale} value={locale}>
                {getLocaleEndonym(locale)}
              </option>
            ))}
          </Select>
        </SettingsRow>
        <SettingsRow title={t('language.translationTarget.label')} description={t('language.translationTarget.description')}>
          <Select
            className="settings-select w-full max-w-[220px]"
            value={settings.general.translationTargetLanguage}
            onChange={(event) => updateGeneral({
              translationTargetLanguage: normalizeTranslationTargetPreference(event.target.value),
            })}
            aria-label={t('language.translationTarget.label')}
            data-testid="settings-translation-target"
          >
            <option value="auto">{t('language.translationTarget.auto')}</option>
            {TRANSLATION_LANGUAGES.map((language) => (
              <option key={language} value={language}>
                {translationLanguageEndonym(language)}
              </option>
            ))}
          </Select>
        </SettingsRow>
      </SettingsSection>
      <SettingsSection
        title={t('general.privacySection')}
        description={t('general.privacySectionDescription')}
      >
        <SettingsRow
          title={t('general.shareUsageData')}
          description={t('general.shareUsageDataDescription')}
        >
          <span className={cn('el-switch', settings.general.shareUsageData && 'is-checked')}>
            <button
              type="button"
              role="switch"
              aria-checked={settings.general.shareUsageData}
              className="settings-switch-button"
              aria-label={t('general.shareUsageData')}
              onClick={() => updateGeneral({ shareUsageData: !settings.general.shareUsageData })}
              data-testid="share-usage-data-toggle"
            >
              {settings.general.shareUsageData ? t('common.enabled') : t('common.disabled')}
            </button>
          </span>
        </SettingsRow>
        <SettingsRow
          title={t('general.analyticsPrivacyPolicy')}
          description={t('general.analyticsPrivacyPolicyDescription')}
        >
          <Button variant="outline" onClick={() => void openExternalURL(KITION_PRIVACY_URL)}>
            <ShieldCheck className="size-4" />
            {t('general.openPrivacyPolicy')}
          </Button>
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title={t('general.launchSection')}>
        {generalToggleFields.map((item) => (
          <SettingsRow
            key={item.field}
            title={t(item.titleKey)}
            description={item.descriptionKey ? t(item.descriptionKey) : undefined}
          >
            <span className={cn('el-switch', Boolean(settings.general[item.field]) && 'is-checked')}>
              <button
                type="button"
                role="switch"
                aria-checked={Boolean(settings.general[item.field])}
                className="settings-switch-button"
                aria-label={t(item.titleKey)}
                onClick={() => updateGeneral({ [item.field]: !settings.general[item.field] })}
              >
                {settings.general[item.field] ? t('common.enabled') : t('common.disabled')}
              </button>
            </span>
          </SettingsRow>
        ))}
      </SettingsSection>
      <SettingsSection title={t('general.gettingStartedSection')}>
        <SettingsRow
          title={t('general.gettingStarted')}
          description={t('general.gettingStartedDescription')}
        >
          <Button
            variant="outline"
            onClick={() => window.dispatchEvent(new CustomEvent('kition:onboarding:open'))}
            data-testid="reopen-getting-started"
          >
            {t('general.reopenGettingStarted')}
          </Button>
        </SettingsRow>
      </SettingsSection>
      <SettingsSection
        title={t('general.sampleDataSection')}
        description={t('general.sampleDataDescription')}
      >
        <SettingsRow
          title={t('general.onboardingGuides')}
          description={t('general.onboardingGuidesDescription')}
        >
          <Button variant="outline" onClick={() => setGettingStartedGuidesOpen(true)}>
            {t('common.open')}
          </Button>
        </SettingsRow>
      </SettingsSection>
      <SettingsActionBar
        dirty={!isPristine(settings.general, pristine.general)}
        saving={saving}
        onSave={() => void handleSave()}
        onCancel={handleCancel}
        lastSavedAt={lastSavedAt}
      />
      {gettingStartedGuidesOpen ? (
        <OnboardingGuidesPanel onClose={() => setGettingStartedGuidesOpen(false)} />
      ) : null}
      {feedback ? <div className="settings-feedback">{feedback}</div> : null}
    </div>
  )
}
