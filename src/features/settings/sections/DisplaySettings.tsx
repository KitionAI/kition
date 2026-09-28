import { useEffect, useState } from 'react'
import { applyDesktopAppearance, applyDesktopDisplay, createDefaultDesktopDisplaySettings, createDefaultDesktopSettings, loadDesktopSettings, saveDesktopSettings } from '@/services/desktopSettings'
import type { DesktopDisplaySettings, DesktopSettingsState, DesktopThemeMode } from '@/types/desktopSettings'
import { Button, Input, Select } from '@/components/ui'
import { SettingsPaneHeader, SettingsSection, SettingsRow, SettingsActionBar } from '@/features/settings/primitives'
import { isPristine } from '@/features/settings/dirty'
import { useTranslation } from '@/i18n'
import { cn } from '@/lib/utils'
import { RotateCcw } from 'lucide-react'
import { preserveLiveThemePreview } from '@/features/settings/sections/themePreview'

const themeModeOptions: Array<{ value: DesktopThemeMode }> = [
  { value: 'light' },
  { value: 'dark' },
  { value: 'auto' },
]

const displayDensityOptions: Array<{ value: DesktopDisplaySettings['density'] }> = [
  { value: 'compact' },
  { value: 'normal' },
  { value: 'relaxed' },
]

const displayLineHeightOptions: Array<{ value: DesktopDisplaySettings['agentTimelineLineHeight'] }> = [
  { value: 'tight' },
  { value: 'normal' },
  { value: 'loose' },
]

const displayCodeFontOptions: Array<{ label: string; value: DesktopDisplaySettings['codeFontFamily'] }> = [
  { label: 'JetBrains Mono', value: 'JetBrains Mono' },
  { label: 'Fira Code', value: 'Fira Code' },
  { label: 'Menlo', value: 'Menlo' },
  { label: 'Consolas', value: 'Consolas' },
  { label: '', value: 'system-ui' },
]

type UpdateDisplay = <Field extends keyof DesktopDisplaySettings>(field: Field, value: DesktopDisplaySettings[Field]) => void

type DisplaySectionProps = {
  display: DesktopDisplaySettings
  theme: DesktopThemeMode
  onUpdate: UpdateDisplay
  onUpdateTheme: (value: DesktopThemeMode) => void
}

export function DisplaySettings() {
  const { t } = useTranslation('settings')
  const [settings, setSettings] = useState<DesktopSettingsState>(createDefaultDesktopSettings())
  const [pristine, setPristine] = useState<DesktopSettingsState>(createDefaultDesktopSettings())
  const [feedback, setFeedback] = useState('')
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
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

  function updateDisplay<Field extends keyof DesktopDisplaySettings>(
    field: Field,
    value: DesktopDisplaySettings[Field],
  ) {
    setFeedback('')
    const next = { ...settings, display: { ...settings.display, [field]: value } }
    setSettings(next)
    applyDesktopDisplay(next.display)
  }

  function updateTheme(value: DesktopThemeMode) {
    setFeedback('')
    const next = { ...settings, general: { ...settings.general, theme: value } }
    setSettings(next)
    applyDesktopAppearance(value)
  }

  async function handleSave() {
    setSaving(true)
    try {
      const saved = await saveDesktopSettings(preserveLiveThemePreview(settings))
      setSettings(saved)
      setPristine(saved)
      applyDesktopDisplay(saved.display)
      setFeedback(t('common.saved'))
      setLastSavedAt(Date.now())
    } catch (error: any) {
      setFeedback(error?.message || t('display.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  function handleCancel() {
    setSettings(pristine)
    applyDesktopDisplay(pristine.display)
    applyDesktopAppearance(pristine.general.theme)
    setFeedback('')
  }

  async function resetToDefaults() {
    const defaults = createDefaultDesktopDisplaySettings()
    const next = preserveLiveThemePreview({
      ...settings,
      display: defaults,
    })
    setSettings(next)
    setPristine(next)
    applyDesktopDisplay(defaults)
    try {
      await saveDesktopSettings(next)
      setFeedback(t('display.restored'))
    } catch (error: any) {
      setFeedback(error?.message || t('common.restoreFailed'))
    }
  }

  if (loading) {
    return (
      <div className="settings-pane">
        <SettingsPaneHeader title={t('display.paneTitle')} description={t('display.paneDescription')} />
        <div className="settings-pane-loading">{t('display.loading')}</div>
      </div>
    )
  }

  const display = settings.display

  return (
    <div className="settings-pane">
      <SettingsPaneHeader title={t('display.paneTitle')} description={t('display.paneDescription')} />
      <DisplayAppearanceSection display={display} theme={settings.general.theme} onUpdate={updateDisplay} onUpdateTheme={updateTheme} />
      <DisplayTypographySection display={display} theme={settings.general.theme} onUpdate={updateDisplay} onUpdateTheme={updateTheme} />
      {feedback ? <div className="settings-feedback">{feedback}</div> : null}
      <SettingsActionBar
        dirty={
          !isPristine(settings.display, pristine.display)
          || settings.general.theme !== pristine.general.theme
        }
        onSave={handleSave}
        onCancel={handleCancel}
        saving={saving}
        lastSavedAt={lastSavedAt}
        destructive={
          <Button variant="outline" size="sm" onClick={() => void resetToDefaults()}>
            <RotateCcw className="size-4" />
            {t('display.restoreDefaults')}
          </Button>
        }
      />
    </div>
  )
}

function DisplayAppearanceSection({ display, theme, onUpdate, onUpdateTheme }: DisplaySectionProps) {
  const { t } = useTranslation('settings')
  return (
    <SettingsSection title={t('display.appearanceSection')}>
      <SettingsRow
        title={t('display.theme')}
        description={t('display.themeDescription')}
      >
        <div className="settings-toggle-group">
          {themeModeOptions.map((item) => (
            <Button
              key={item.value}
              size="sm"
              variant={theme === item.value ? 'default' : 'outline'}
              onClick={() => onUpdateTheme(item.value)}
            >
              {t(`themeMode.${item.value}`)}
            </Button>
          ))}
        </div>
      </SettingsRow>
      <SettingsRow
        title={t('display.uiZoom')}
        description={t('display.uiZoomDescription', { percent: Math.round(display.zoomLevel * 100) })}
      >
        <input
          type="range"
          min={0.85}
          max={1.5}
          step={0.05}
          value={display.zoomLevel}
          aria-label={t('display.uiZoom')}
          onChange={(event) => onUpdate('zoomLevel', Number(event.target.value))}
          className="w-full max-w-[220px]"
        />
      </SettingsRow>
      <SettingsRow
        title={t('display.uiDensity')}
        description={t('display.uiDensityDescription')}
      >
        <div className="settings-toggle-group">
          {displayDensityOptions.map((item) => (
            <Button
              key={item.value}
              size="sm"
              variant={display.density === item.value ? 'default' : 'outline'}
              onClick={() => onUpdate('density', item.value)}
            >
              {t(`display.density.${item.value}`)}
            </Button>
          ))}
        </div>
      </SettingsRow>
      <SettingsRow
        title={t('display.reduceMotion')}
        description={t('display.reduceMotionDescription')}
      >
        <span className={cn('el-switch', display.reduceMotion && 'is-checked')}>
          <button
            type="button"
            role="switch"
            aria-checked={display.reduceMotion}
            className="settings-switch-button"
            aria-label={t('display.reduceMotion')}
            onClick={() => onUpdate('reduceMotion', !display.reduceMotion)}
          >
            {display.reduceMotion ? t('common.enabled') : t('common.disabled')}
          </button>
        </span>
      </SettingsRow>
      <SettingsRow
        title={t('display.showDocumentToolbar')}
        description={t('display.showDocumentToolbarDescription')}
      >
        <span className={cn('el-switch', display.showDocumentToolbar && 'is-checked')}>
          <button
            type="button"
            role="switch"
            aria-checked={display.showDocumentToolbar}
            className="settings-switch-button"
            aria-label={t('display.showDocumentToolbar')}
            onClick={() => onUpdate('showDocumentToolbar', !display.showDocumentToolbar)}
          >
            {display.showDocumentToolbar ? t('common.enabled') : t('common.disabled')}
          </button>
        </span>
      </SettingsRow>
    </SettingsSection>
  )
}

function DisplayTypographySection({ display, theme, onUpdate, onUpdateTheme }: DisplaySectionProps) {
  const { t } = useTranslation('settings')
  return (
    <SettingsSection title={t('display.typographySection')}>
      <SettingsRow title={t('display.codeFont')}>
        <Select
          className="settings-select w-full max-w-[220px]"
          value={display.codeFontFamily}
          onChange={(event) => onUpdate('codeFontFamily', event.target.value as DesktopDisplaySettings['codeFontFamily'])}
        >
          {displayCodeFontOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.value === 'system-ui' ? t('display.codeFontSystem') : option.label}
            </option>
          ))}
        </Select>
      </SettingsRow>
      <SettingsRow
        title={t('display.codeFontSize')}
        description={t('display.codeFontSizeDescription')}
      >
        <Input
          type="number"
          min={12}
          max={18}
          step={1}
          value={display.codeFontSize}
          onChange={(event) => onUpdate('codeFontSize', Number(event.target.value))}
          className="settings-input w-full max-w-[120px]"
          aria-label={t('display.codeFontSize')}
        />
      </SettingsRow>
      <SettingsRow title={t('display.agentTimelineLineHeight')}>
        <div className="settings-toggle-group">
          {displayLineHeightOptions.map((item) => (
            <Button
              key={item.value}
              size="sm"
              variant={display.agentTimelineLineHeight === item.value ? 'default' : 'outline'}
              onClick={() => onUpdate('agentTimelineLineHeight', item.value)}
            >
              {t(`display.lineHeight.${item.value}`)}
            </Button>
          ))}
        </div>
      </SettingsRow>
    </SettingsSection>
  )
}
