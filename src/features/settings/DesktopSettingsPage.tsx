import type { ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { TFunction } from 'i18next'
import {
  getDesktopInfo,
  isDesktopRuntime,
  openExternalURL,
  openRuntimePath,
  retryDesktopBackendStart,
  type DesktopInfo,
} from '@/services/desktop'
import { discoverProviderModels } from '@/api/desktop'
import {
  applyDesktopAppearance,
  applyDesktopDisplay,
  createDefaultDesktopDisplaySettings,
  createDefaultDesktopSettings,
  desktopProviderCatalog,
  KITION_CONSOLE_DEFAULT_MODELS,
  KITION_CONSOLE_DEFAULT_TEXT_MODELS,
  loadDesktopSettings,
  normalizeProviderBaseURL,
  saveDesktopSettings,
} from '@/services/desktopSettings'
import { checkForUpdates, downloadUpdate, installUpdate, setAutoCheckUpdates, setBetaChannel, type UpdateState } from '@/services/desktopUpdates'
import { useUpdateState } from '@/features/updates/useUpdateState'
import type {
  DesktopDisplaySettings,
  DesktopProviderKind,
  DesktopSettingsState,
  DesktopThemeMode,
} from '@/types/desktopSettings'
import { Button, Input, Select } from '@/components/ui'
import { KitionAccountPanel } from '@/features/account/components/KitionAccountPanel'
import { emailProviderCatalog } from '@/features/emailProviders/emailProviderCatalog'
import { EmailProvidersPane } from '@/features/emailProviders/EmailProvidersPane'
import { OnboardingGuidesPanel } from '@/features/settings/OnboardingGuidesPanel'
import { AiModelsPane } from '@/features/settings/AiModelsPane'
import { NetworkSettings } from '@/features/settings/NetworkSettings'
import { SupportAndTrustSettings } from '@/features/support/components/SupportAndTrustSettings'
import { ProductAnalyticsInspector } from '@/features/analytics/components/ProductAnalyticsInspector'
import { KITION_PRIVACY_URL } from '@/features/account/lib/accountLinks'
import {
  SettingsPaneHeader,
  SettingsSection,
  SettingsRow,
  SettingsActionBar,
  SettingsSidebarHeader,
} from '@/features/settings/primitives'
import { isPristine } from '@/features/settings/dirty'
import { getCurrentLocale, setCurrentLocale, SUPPORTED_LOCALES, useTranslation, type Locale } from '@/i18n'
import { cn } from '@/lib/utils'
import {
  Bot,
  ChevronDown,
  CircleUserRound,
  Database,
  FolderOpen,
  Info,
  Mail,
  Monitor,
  Network,
  RotateCcw,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  X,
} from 'lucide-react'

const settingsSections = [
  { key: 'general', icon: Settings, group: 'primary' },
  { key: 'account', icon: CircleUserRound, group: 'primary' },
  { key: 'models', icon: Bot, group: 'primary' },
  { key: 'connections', icon: Mail, group: 'primary' },
  { key: 'display', icon: Monitor, group: 'primary' },
  { key: 'network', icon: Network, group: 'advanced' },
  { key: 'runtime', icon: Database, group: 'advanced' },
  { key: 'developer', icon: SlidersHorizontal, group: 'advanced' },
  { key: 'about', icon: Info, group: 'primary' },
] as const

const primarySettingsSections = settingsSections.filter((section) => section.group === 'primary')
const advancedSettingsSections = settingsSections.filter((section) => section.group === 'advanced')

const languageEndonyms: Record<Locale, string> = {
  'en-US': 'English',
  'es-ES': 'Español',
  'fr-FR': 'Français',
  'pt-BR': 'Português (Brasil)',
  'ru-RU': 'Русский',
}

const themeModeOptions: Array<{ value: DesktopThemeMode }> = [
  { value: 'light' },
  { value: 'dark' },
  { value: 'auto' },
]

type GeneralToggleField = {
  [K in keyof DesktopSettingsState['general']]: DesktopSettingsState['general'][K] extends boolean ? K : never
}[keyof DesktopSettingsState['general']]

const generalToggleFields: ReadonlyArray<{ field: GeneralToggleField; titleKey: string; descriptionKey?: string }> = [
  { field: 'restoreWorkspaceOnLaunch', titleKey: 'general.restoreWorkspaceOnLaunch' },
  { field: 'confirmBeforeQuit', titleKey: 'general.confirmBeforeQuit' },
  { field: 'autoCheckUpdates', titleKey: 'general.autoCheckUpdates' },
]

export type SettingsSectionKey = typeof settingsSections[number]['key']
type SettingsSectionDefinition = typeof settingsSections[number]

// Where each section's searchable field labels/descriptions live in the i18n
// resources. Most panes read from the same-named path under the `settings`
// namespace, but some pull in extra subtrees (general also renders `language`,
// namespace, while connections has its own top-level namespace.
const settingsSectionContentSources: Record<SettingsSectionKey, Array<{ ns: string; path?: string }>> = {
  general: [{ ns: 'settings', path: 'general' }, { ns: 'settings', path: 'language' }],
  account: [{ ns: 'settings', path: 'account' }],
  models: [{ ns: 'settings', path: 'models' }],
  connections: [{ ns: 'connections' }],
  display: [{ ns: 'settings', path: 'display' }],
  network: [{ ns: 'settings', path: 'network' }],
  runtime: [{ ns: 'settings', path: 'runtime' }],
  developer: [{ ns: 'settings', path: 'developer' }],
  about: [{ ns: 'settings', path: 'about' }],
}

function collectSearchableStrings(node: unknown, out: string[]) {
  if (typeof node === 'string') {
    out.push(node)
  } else if (node && typeof node === 'object') {
    for (const value of Object.values(node)) {
      collectSearchableStrings(value, out)
    }
  }
}

function formatSettingsDateTime(value?: string) {
  if (!value) {
    return 'Not synced yet'
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }

  return date.toLocaleString(getCurrentLocale(), {
    hour12: false,
  })
}

function formatSettingsDateTimeParts(value?: string) {
  if (!value) {
    return null
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return null
  }

  return {
    date: date.toLocaleDateString(getCurrentLocale()),
    time: date.toLocaleTimeString(getCurrentLocale(), { hour12: false }),
  }
}

function resolveActiveProviderModelSelection(settings: DesktopSettingsState) {
  const activeProviderKind = settings.providers[settings.models.activeProvider]?.enabled
    ? settings.models.activeProvider
    : (desktopProviderCatalog.find((item) => settings.providers[item.kind]?.enabled)?.kind || settings.models.activeProvider)
  const activeProvider = settings.providers[activeProviderKind]
  const currentModels = activeProvider?.discoveredModels || []
  const selectedModel = settings.models.selectedModelByProvider[activeProviderKind]
  const resolvedModel = selectedModel && currentModels.includes(selectedModel)
    ? selectedModel
    : currentModels[0] || ''

  return {
    activeProviderKind,
    activeProvider,
    currentModels,
    selectedModel: resolvedModel,
  }
}

function validateDesktopProvider(settings: DesktopSettingsState, kind: DesktopProviderKind) {
  const provider = settings.providers[kind]
  if (!provider.baseUrl && kind !== 'custom') {
    provider.baseUrl = desktopProviderCatalog.find((item) => item.kind === kind)?.defaultBaseUrl || provider.baseUrl
  }

  if ((kind === 'openai' || kind === 'anthropic') && !provider.apiKey) {
    return 'Please enter an API Key first'
  }
  if (kind === 'custom') {
    if (!provider.baseUrl) {
      return 'Please enter the custom Provider URL first'
    }
    if (!provider.apiKey && !provider.accessToken) {
      return 'Please enter the custom Provider token first'
    }
  }

  return ''
}

function preserveLiveThemePreview(settings: DesktopSettingsState): DesktopSettingsState {
  if (typeof document === 'undefined') {
    return settings
  }

  // Prefer the canonical dataset (set by applyDesktopAppearance). If that's
  // unset or stale, fall back to the actually-applied .dark class so the
  // segmented Theme control stays in sync with whatever is rendered — even if
  // the dark class was toggled by an external script (system theme handler,
  // playwright, etc.).
  const datasetTheme = document.documentElement.dataset.desktopThemeMode
  if (datasetTheme === 'light' || datasetTheme === 'dark' || datasetTheme === 'auto') {
    return {
      ...settings,
      general: {
        ...settings.general,
        theme: datasetTheme as DesktopSettingsState['general']['theme'],
      },
    }
  }

  const hasDarkClass = document.documentElement.classList.contains('dark')
  const resolved: DesktopSettingsState['general']['theme'] = hasDarkClass ? 'dark' : 'light'
  if (settings.general.theme === resolved) {
    return settings
  }
  return {
    ...settings,
    general: {
      ...settings.general,
      theme: resolved,
    },
  }
}

async function discoverDesktopProviderModels(settings: DesktopSettingsState, kind: DesktopProviderKind) {
  const provider = settings.providers[kind]
  return discoverProviderModels({
    provider_type: kind,
    base_url: provider.baseUrl || undefined,
    api_key: provider.apiKey || undefined,
    access_token: provider.accessToken || undefined,
    models_path: provider.modelsPath || undefined,
    auth_header: provider.authHeader || undefined,
    auth_scheme: provider.authScheme,
  })
}

function shouldRetryProviderModelDiscovery(error: unknown) {
  const message = String((error as { message?: string })?.message || '').trim().toLowerCase()
  if (!message) {
    return false
  }
  return (
    message.includes('network error') ||
    message.includes('network error') ||
    message.includes('request failed') ||
    message.includes('service unavailable') ||
    message.includes('service unavailable') ||
    message.includes('desktop local service not ready')
  )
}

async function syncDesktopProviderModels(settings: DesktopSettingsState, kind: DesktopProviderKind) {
  const next = preserveLiveThemePreview(structuredClone(settings))
  const provider = next.providers[kind]
  provider.baseUrl = normalizeProviderBaseURL(kind, provider.baseUrl)

  const validationError = validateDesktopProvider(next, kind)
  if (validationError) {
    throw new Error(validationError)
  }

  if (kind === 'kition_console') {
    const models = [...KITION_CONSOLE_DEFAULT_MODELS]
    provider.enabled = true
    provider.discoveredModels = models
    provider.lastSyncedAt = new Date().toISOString()
    next.models.activeProvider = kind
    if (!next.models.selectedModelByProvider[kind] || !KITION_CONSOLE_DEFAULT_TEXT_MODELS.includes(next.models.selectedModelByProvider[kind] || '')) {
      next.models.selectedModelByProvider[kind] = KITION_CONSOLE_DEFAULT_TEXT_MODELS[0]
    }
    const selectedModel = next.models.selectedModelByProvider[kind] || KITION_CONSOLE_DEFAULT_TEXT_MODELS[0]
    if (!next.models.preferredDefaultModel || !models.includes(next.models.preferredDefaultModel)) {
      next.models.preferredDefaultModel = selectedModel
    }
    if (!next.models.preferredChatModel || !models.includes(next.models.preferredChatModel)) {
      next.models.preferredChatModel = selectedModel
    }
    if (!next.models.preferredWritingModel || !models.includes(next.models.preferredWritingModel)) {
      next.models.preferredWritingModel = selectedModel
    }
    return saveDesktopSettings(next)
  }

  let response: { models?: string[]; fetched_at?: string }
  try {
    response = await discoverDesktopProviderModels(next, kind)
  } catch (error) {
    if (!isDesktopRuntime() || !shouldRetryProviderModelDiscovery(error)) {
      throw error
    }
    await retryDesktopBackendStart().catch(() => null)
    response = await discoverDesktopProviderModels(next, kind)
  }

  const models = Array.isArray(response?.models) ? response.models.filter(Boolean) : []
  if (!models.length) {
    throw new Error('No usable models returned from the provider endpoint')
  }

  provider.enabled = true
  provider.discoveredModels = models
  provider.lastSyncedAt = response.fetched_at || new Date().toISOString()
  next.models.activeProvider = kind

  if (!next.models.selectedModelByProvider[kind]) {
    next.models.selectedModelByProvider[kind] = models[0]
  }

  const selectedModel = next.models.selectedModelByProvider[kind] || models[0]
  if (!next.models.preferredDefaultModel || !models.includes(next.models.preferredDefaultModel)) {
    next.models.preferredDefaultModel = selectedModel
  }
  if (!next.models.preferredChatModel || !models.includes(next.models.preferredChatModel)) {
    next.models.preferredChatModel = selectedModel
  }
  if (!next.models.preferredWritingModel || !models.includes(next.models.preferredWritingModel)) {
    next.models.preferredWritingModel = selectedModel
  }

  return saveDesktopSettings(next)
}

function Label({ title, children }: { title: string; children: ReactNode }) {
  return <label className="el-form-item block space-y-2"><span className="text-sm font-medium text-muted-foreground">{title}</span>{children}</label>
}

function GeneralSettings() {
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
                {languageEndonyms[locale]}
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

function AccountSettings() {
  return (
    <div className="settings-pane settings-account-pane">
      <KitionAccountPanel />
    </div>
  )
}

function DeveloperSettings() {
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


function RuntimeSettings() {
  const { t } = useTranslation('settings')
  const [desktopInfo, setDesktopInfo] = useState<DesktopInfo | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let mounted = true
    getDesktopInfo()
      .then((info) => {
        if (mounted) {
          setDesktopInfo(info)
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

  const runtimeRows: Array<{ label: string; kind: 'data' | 'cache' | 'logs' | 'exports'; path: string }> = [
    { label: t('runtime.dataDir'), kind: 'data', path: desktopInfo?.data_dir || '' },
    { label: t('runtime.cacheDir'), kind: 'cache', path: desktopInfo?.cache_dir || '' },
    { label: t('runtime.logsDir'), kind: 'logs', path: desktopInfo?.logs_dir || '' },
    { label: t('runtime.exportsDir'), kind: 'exports', path: desktopInfo?.exports_dir || '' },
  ]

  async function handleOpen(kind: 'data' | 'cache' | 'logs' | 'exports') {
    await openRuntimePath(kind)
  }

  if (loading) {
    return (
      <div className="settings-pane">
        <SettingsPaneHeader title={t('runtime.paneTitle')} description={t('runtime.paneDescription')} />
        <div className="settings-pane-loading">{t('runtime.loading')}</div>
      </div>
    )
  }

  if (!desktopInfo) {
    return (
      <div className="settings-pane">
        <SettingsPaneHeader title={t('runtime.paneTitle')} description={t('runtime.paneDescription')} />
        <div className="settings-pane-empty">{t('runtime.empty')}</div>
      </div>
    )
  }

  return (
    <div className="settings-pane">
      <SettingsPaneHeader title={t('runtime.paneTitle')} description={t('runtime.paneDescription')} />
      <SettingsSection title={t('runtime.section')}>
        {runtimeRows.map((row) => (
          <SettingsRow
            key={row.kind}
            title={row.label}
            description={row.path || t('runtime.desktopOnly')}
          >
            <Button variant="outline" size="sm" onClick={() => void handleOpen(row.kind)}>
              <FolderOpen className="size-4" />
              {t('common.open')}
            </Button>
          </SettingsRow>
        ))}
      </SettingsSection>
    </div>
  )
}

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

function DisplaySettings() {
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
                variant={settings.general.theme === item.value ? 'default' : 'outline'}
                onClick={() => updateTheme(item.value)}
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
            onChange={(event) => updateDisplay('zoomLevel', Number(event.target.value))}
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
                onClick={() => updateDisplay('density', item.value)}
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
              onClick={() => updateDisplay('reduceMotion', !display.reduceMotion)}
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
              onClick={() => updateDisplay('showDocumentToolbar', !display.showDocumentToolbar)}
            >
              {display.showDocumentToolbar ? t('common.enabled') : t('common.disabled')}
            </button>
          </span>
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title={t('display.typographySection')}>
        <SettingsRow title={t('display.codeFont')}>
          <Select
            className="settings-select w-full max-w-[220px]"
            value={display.codeFontFamily}
            onChange={(event) => updateDisplay('codeFontFamily', event.target.value as DesktopDisplaySettings['codeFontFamily'])}
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
            onChange={(event) => updateDisplay('codeFontSize', Number(event.target.value))}
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
                onClick={() => updateDisplay('agentTimelineLineHeight', item.value)}
              >
                {t(`display.lineHeight.${item.value}`)}
              </Button>
            ))}
          </div>
        </SettingsRow>
      </SettingsSection>
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

function formatBuildTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return date.toLocaleString(getCurrentLocale(), { hour12: false })
}

const GITHUB_REPO_URL = 'https://github.com/KitionAI/kition'

function AboutSettings() {
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
      return state.message
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
      return <Button variant="outline" disabled>{t('about.update.actionDownloading')}</Button>
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

type DesktopSettingsPageProps = {
  initialSection?: SettingsSectionKey
  onClose?: () => void
}

export function DesktopSettingsPage({ initialSection, onClose }: DesktopSettingsPageProps = {}) {
  const { t, i18n } = useTranslation('settings')
  const [activeSection, setActiveSection] = useState<SettingsSectionKey>(() => initialSection || 'general')
  const [search, setSearch] = useState('')
  const [advancedOpen, setAdvancedOpen] = useState(() => (
    advancedSettingsSections.some((section) => section.key === initialSection)
  ))
  const searchIndex = useMemo(() => {
    const map = new Map<SettingsSectionKey, string>()
    for (const section of settingsSections) {
      const parts: string[] = [t(`sections.${section.key}.label`)]
      for (const source of settingsSectionContentSources[section.key]) {
        const bundle = i18n.getResourceBundle(i18n.language, source.ns)
        collectSearchableStrings(source.path ? bundle?.[source.path] : bundle, parts)
      }
      // Provider names live in code catalogs, so fold them into the matching
      // pane haystacks explicitly.
      if (section.key === 'models') {
        for (const provider of desktopProviderCatalog) {
          parts.push(provider.label, provider.sublabel, provider.descriptor, provider.badge, provider.authLabel)
        }
      }
      if (section.key === 'connections') {
        for (const provider of emailProviderCatalog) {
          parts.push(provider.label, provider.credentialLabel, provider.credentialHint)
        }
      }
      map.set(section.key, parts.join(' ').toLowerCase())
    }
    return map
  }, [t, i18n, i18n.language])
  const query = search.trim().toLowerCase()
  const advancedLabelMatches = Boolean(query && t('sections.advanced.label').toLowerCase().includes(query))
  const visiblePrimarySections = query
    ? primarySettingsSections.filter((section) => (searchIndex.get(section.key) ?? '').includes(query))
    : primarySettingsSections
  const visibleAdvancedSections = query
    ? advancedLabelMatches
      ? advancedSettingsSections
      : advancedSettingsSections.filter((section) => (searchIndex.get(section.key) ?? '').includes(query))
    : advancedSettingsSections
  const visibleMainSections = visiblePrimarySections.filter((section) => section.key !== 'about')
  const visibleAboutSection = visiblePrimarySections.find((section) => section.key === 'about')
  const showAdvancedGroup = visibleAdvancedSections.length > 0
  const showAdvancedChildren = showAdvancedGroup && (advancedOpen || Boolean(query) || (
    advancedSettingsSections.some((section) => section.key === activeSection)
  ))
  const hasVisibleSections = visiblePrimarySections.length > 0 || visibleAdvancedSections.length > 0

  useEffect(() => {
    if (!settingsSections.some((section) => section.key === activeSection)) {
      setActiveSection('general')
    }
  }, [activeSection])

  useEffect(() => {
    if (!initialSection) {
      return
    }
    setActiveSection((current) => (current === initialSection ? current : initialSection))
  }, [initialSection])

  useEffect(() => {
    if (advancedSettingsSections.some((section) => section.key === activeSection)) {
      setAdvancedOpen(true)
    }
  }, [activeSection])

  function switchSection(section: SettingsSectionKey) {
    setActiveSection(section)
    if (typeof window !== 'undefined' && window.location.pathname === '/settings') {
      const nextURL = `${window.location.pathname}?section=${section}`
      window.history.replaceState(window.history.state, '', nextURL)
    }
  }

  function renderSectionButton(section: SettingsSectionDefinition, child = false) {
    const SectionIcon = section.icon
    const active = activeSection === section.key
    return (
      <button
        key={section.key}
        className={cn('settings-nav-button', child && 'is-child', active && 'is-active')}
        onClick={() => switchSection(section.key)}
        aria-current={active ? 'page' : undefined}
      >
        <SectionIcon className="size-4" />
        <strong>{t(`sections.${section.key}.label`)}</strong>
      </button>
    )
  }

  useEffect(() => {
    if (!onClose) {
      return
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  function handleRequestClose() {
    onClose?.()
  }

  return (
    <div className="settings-modal-stage" onClick={handleRequestClose}>
      <section
        className="settings-modal-window"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="settings-modal-close"
          onClick={handleRequestClose}
          aria-label={t('actions.close')}
          title={t('actions.close')}
        >
          <X className="size-4" />
        </button>
        <div className="settings-shell">
          <aside className="settings-sidebar-panel">
            <h1 id="settings-title" className="sr-only">{t('sidebar.title')}</h1>
            <SettingsSidebarHeader search={search} onSearchChange={setSearch} />
            <nav className="settings-nav-list" aria-label={t('sidebar.categoriesLabel')}>
              {!hasVisibleSections ? (
                <p className="px-3 py-2 text-sm text-muted-foreground">{t('sidebar.noMatches')}</p>
              ) : (
                <>
                  {visibleMainSections.map((section) => renderSectionButton(section))}
                  {showAdvancedGroup ? (
                    <div className="settings-nav-advanced">
                    <button
                        type="button"
                        className="settings-nav-button settings-nav-disclosure"
                        aria-expanded={showAdvancedChildren}
                        onClick={() => setAdvancedOpen((current) => !current)}
                    >
                        <SlidersHorizontal className="size-4" />
                        <strong>{t('sections.advanced.label')}</strong>
                        <ChevronDown className={cn('settings-nav-chevron size-4', showAdvancedChildren && 'rotate-180')} />
                    </button>
                      {showAdvancedChildren ? (
                        <div className="settings-nav-children">
                          {visibleAdvancedSections.map((section) => renderSectionButton(section, true))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  {visibleAboutSection ? renderSectionButton(visibleAboutSection) : null}
                </>
              )}
            </nav>
          </aside>

          <div className="settings-modal-content">
            {activeSection === 'general' ? <GeneralSettings /> : null}
            {activeSection === 'account' ? <AccountSettings /> : null}
            {activeSection === 'models' ? <AiModelsPane /> : null}
            {activeSection === 'connections' ? <EmailProvidersPane /> : null}
            {activeSection === 'display' ? <DisplaySettings /> : null}
            {activeSection === 'network' ? <NetworkSettings /> : null}
            {activeSection === 'runtime' ? <RuntimeSettings /> : null}
            {activeSection === 'developer' ? <DeveloperSettings /> : null}
            {activeSection === 'about' ? <AboutSettings /> : null}
          </div>
        </div>
      </section>
    </div>
  )
}
