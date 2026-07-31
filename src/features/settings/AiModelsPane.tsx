import { useEffect, useState } from 'react'
import { AlertTriangle, Plus, RefreshCcw, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button, Disclosure, Input, PasswordInput, Select } from '@/components/ui'
import { discoverProviderModels } from '@/api/desktop'
import {
  type KitionAccountState,
  useKitionAccount,
} from '@/features/account/hooks/useKitionAccount'
import { getKitionAccountLinks } from '@/features/account/lib/accountLinks'
import {
  isKitionAccountAuthenticated,
  isKitionAccountUsable,
} from '@/features/account/lib/accountState'
import {
  desktopProviderCatalog,
  loadDesktopSettings,
  saveDesktopSettings,
} from '@/services/desktopSettings'
import { isLikelyTextGenerationModel } from '@/services/modelCapabilities'
import type { DesktopProviderKind, DesktopSettingsState } from '@/types/desktopSettings'
import { getCurrentLocale, useTranslation } from '@/i18n'
import { openExternalURL } from '@/services/desktop'
import {
  SettingsPaneHeader, SettingsSection, SettingsRow, SettingsActionBar,
} from './primitives'
import { isPristine } from './dirty'
import {
  customAuthSchemeOptions,
  customWireApiOptions,
  customReasoningOptions,
  hostedWebSearchVersionOptions,
} from './providerOptions'
import { DisconnectConfirmDialog } from './DisconnectConfirmDialog'

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

type ProviderFieldsProps = {
  kind: DesktopProviderKind
  provider: DesktopSettingsState['providers'][DesktopProviderKind]
  onPatch: (patch: Partial<DesktopSettingsState['providers'][DesktopProviderKind]>) => void
}

type ConnectionProps = ProviderFieldsProps & {
  kitionAccount: KitionAccountState
  onKitionAccountConnect: () => void
  onKitionAccountCancel: () => void
  onKitionAccountTopup: () => void
}

function ProviderConnectionFields({
  kind,
  provider,
  onPatch,
  kitionAccount,
  onKitionAccountConnect,
  onKitionAccountCancel,
  onKitionAccountTopup,
}: ConnectionProps) {
  const { t } = useTranslation('settings')
  switch (kind) {
    case 'openai':
    case 'anthropic':
    case 'deepseek':
    case 'kimi':
      return (
        <SettingsRow title={t('models.apiKey')} description={t('models.apiKeyDescription')}>
          <PasswordInput
            className="settings-input"
            aria-label={t('models.apiKey')}
            value={provider.apiKey ?? ''}
            onChange={(event) => onPatch({ apiKey: event.target.value })}
            placeholder={t(
              kind === 'anthropic'
                ? 'models.apiKeyPlaceholderAnthropic'
                : kind === 'deepseek'
                  ? 'models.apiKeyPlaceholder'
                  : 'models.apiKeyPlaceholderOpenai',
            )}
          />
        </SettingsRow>
      )
    case 'custom':
      return (
        <>
          <SettingsRow title={t('models.baseUrl')}>
            <Input
              className="settings-input"
              value={provider.baseUrl ?? ''}
              onChange={(event) => onPatch({ baseUrl: event.target.value })}
              placeholder={t('models.baseUrlPlaceholder')}
            />
          </SettingsRow>
          <SettingsRow title={t('models.apiKey')}>
            <PasswordInput
              className="settings-input"
              aria-label={t('models.apiKey')}
              value={provider.apiKey ?? ''}
              onChange={(event) => onPatch({ apiKey: event.target.value })}
              placeholder={t('models.apiKeyPlaceholder')}
            />
          </SettingsRow>
        </>
      )
    case 'kition_console':
      return (
        <SettingsRow title={t('models.portalSession')} description={t('models.portalSessionDescription')}>
          <div className="flex min-w-52 flex-col items-end gap-2">
            <span className="text-sm text-muted-foreground" data-testid="kition-account-status">
              {kitionAccount.status === 'ready'
                ? t('models.kitionAccountConnected')
                : kitionAccount.status === 'credits_low'
                  ? t('models.kitionAccountCreditsLow')
                  : kitionAccount.status === 'credits_empty'
                    ? t('models.kitionAccountCreditsEmpty')
                : kitionAccount.status === 'connecting'
                  ? t('models.kitionAccountConnecting')
                  : kitionAccount.status === 'loading'
                    ? t('models.kitionAccountChecking')
                    : kitionAccount.status === 'temporary_error'
                      ? t('models.kitionAccountUnavailable')
                      : kitionAccount.status === 'expired'
                        ? t('models.kitionAccountExpired')
                      : t('models.kitionAccountSignedOut')}
            </span>
            {isKitionAccountUsable(kitionAccount.status) ? null : (
              <Button
                size="sm"
                variant={kitionAccount.status === 'connecting' ? 'outline' : 'default'}
                disabled={kitionAccount.status === 'loading'}
                onClick={kitionAccount.status === 'credits_empty'
                  ? onKitionAccountTopup
                  : kitionAccount.status === 'connecting'
                    ? onKitionAccountCancel
                    : onKitionAccountConnect}
                data-testid="kition-account-connect"
              >
                {kitionAccount.status === 'credits_empty'
                  ? t('models.kitionAccountTopup')
                  : kitionAccount.status === 'connecting'
                  ? t('models.kitionAccountCancel')
                  : kitionAccount.status === 'temporary_error'
                    ? t('models.kitionAccountRetry')
                    : t('models.kitionAccountSignIn')}
              </Button>
            )}
          </div>
        </SettingsRow>
      )
  }
  return null
}

function ProviderAdvancedFields({ kind, provider, onPatch }: ProviderFieldsProps) {
  const { t } = useTranslation('settings')
  return (
    <>
      {kind === 'custom' ? (
        <SettingsRow title={t('models.baseUrl')}>
          <Input
            className="settings-input"
            value={provider.baseUrl ?? ''}
            onChange={(event) => onPatch({ baseUrl: event.target.value })}
            placeholder={t('models.baseUrlPlaceholder')}
          />
        </SettingsRow>
      ) : null}
      <SettingsRow title={t('models.modelsEndpoint')} description={t('models.modelsEndpointDescription')}>
        <Input
          className="settings-input"
          value={provider.modelsPath ?? ''}
          onChange={(event) => onPatch({ modelsPath: event.target.value })}
          placeholder={t('models.modelsPathPlaceholder')}
        />
      </SettingsRow>
      {kind === 'custom' ? (
        <>
          <SettingsRow title={t('models.authScheme')}>
            <Select
              className="settings-select"
              value={provider.authScheme}
              onChange={(event) => onPatch({ authScheme: event.target.value as typeof provider.authScheme })}
            >
              {customAuthSchemeOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </Select>
          </SettingsRow>
          <SettingsRow title={t('models.wireApi')}>
            <Select
              className="settings-select"
              value={provider.wireApi}
              onChange={(event) => onPatch({ wireApi: event.target.value as typeof provider.wireApi })}
            >
              {customWireApiOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </Select>
          </SettingsRow>
          <SettingsRow title={t('models.reasoningEffort')}>
            <Select
              className="settings-select"
              value={provider.reasoningEffort}
              onChange={(event) => onPatch({ reasoningEffort: event.target.value as typeof provider.reasoningEffort })}
            >
              {customReasoningOptions.map((option) => (
                <option key={option.value} value={option.value}>{t(`models.reasoning.${option.value}`)}</option>
              ))}
            </Select>
          </SettingsRow>
        </>
      ) : null}
      {kind === 'kition_console' ? (
        <SettingsRow title={t('models.webSearchVersion')}>
          <Select
            className="settings-select"
            value={provider.hostedWebSearchVersion}
            onChange={(event) => onPatch({ hostedWebSearchVersion: event.target.value as typeof provider.hostedWebSearchVersion })}
          >
            {hostedWebSearchVersionOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </Select>
        </SettingsRow>
      ) : null}
    </>
  )
}

type MetadataProps = {
  count: number
  lastSyncedAt?: string
  syncing: boolean
  error?: string
  onSync: () => void
  onRetry: () => void
}

function ProviderMetadataRow({ count, lastSyncedAt, syncing, error, onSync, onRetry }: MetadataProps) {
  const { t } = useTranslation('settings')
  if (error) {
    return (
      <div className="settings-provider-metadata is-error" role="alert">
        <span><AlertTriangle className="mr-2 inline size-4" />{t('models.syncFailed', { error })}</span>
        <Button size="sm" variant="outline" onClick={onRetry}>{t('models.retry')}</Button>
      </div>
    )
  }
  const when = lastSyncedAt ? formatSettingsDateTime(lastSyncedAt) : t('notSynced')
  return (
    <div className="settings-provider-metadata">
      <span>{t('models.modelsCount', { count, when })}</span>
      <Button size="sm" variant="outline" onClick={onSync} disabled={syncing}>
        <RefreshCcw className={cn('mr-2 size-4', syncing && 'animate-spin')} />
        {syncing ? t('models.syncing') : t('models.syncNow')}
      </Button>
    </div>
  )
}

function normalizeDiscoveredModels(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(value.map((model) => String(model || '').trim()).filter(Boolean)))
}

async function syncProviderModelCatalog(
  settings: DesktopSettingsState,
  kind: DesktopProviderKind,
  emptyMessage: string,
  activateProvider: boolean,
) {
  const provider = settings.providers[kind]
  const response = await discoverProviderModels({
    provider_type: kind,
    base_url: provider.baseUrl || undefined,
    api_key: provider.apiKey || undefined,
    access_token: provider.accessToken || undefined,
    models_path: provider.modelsPath || undefined,
    auth_header: provider.authHeader || undefined,
    auth_scheme: provider.authScheme,
  })
  const models = normalizeDiscoveredModels(response?.models)
  if (!models.length) throw new Error(emptyMessage)

  const selectedModelByProvider = { ...settings.models.selectedModelByProvider }
  const currentSelection = selectedModelByProvider[kind] || ''
  const fallbackSelection = kind === 'kition_console'
    ? models.find(isLikelyTextGenerationModel) || ''
    : models[0]
  if (!currentSelection || !models.includes(currentSelection)) {
    if (fallbackSelection) selectedModelByProvider[kind] = fallbackSelection
    else delete selectedModelByProvider[kind]
  }
  const selectedModel = selectedModelByProvider[kind] || fallbackSelection
  const nextModels = {
    ...settings.models,
    activeProvider: activateProvider ? kind : settings.models.activeProvider,
    selectedModelByProvider,
  }
  if (activateProvider && selectedModel) {
    nextModels.preferredDefaultModel = !settings.models.preferredDefaultModel || !models.includes(settings.models.preferredDefaultModel)
      ? selectedModel
      : settings.models.preferredDefaultModel
    nextModels.preferredChatModel = !settings.models.preferredChatModel || !models.includes(settings.models.preferredChatModel)
      ? selectedModel
      : settings.models.preferredChatModel
    nextModels.preferredWritingModel = !settings.models.preferredWritingModel || !models.includes(settings.models.preferredWritingModel)
      ? selectedModel
      : settings.models.preferredWritingModel
  }

  return saveDesktopSettings({
    ...settings,
    providers: {
      ...settings.providers,
      [kind]: {
        ...provider,
        enabled: true,
        discoveredModels: models,
        lastSyncedAt: response.fetched_at || new Date().toISOString(),
      },
    },
    models: nextModels,
  })
}

function KitionCloudModelCatalog({
  models,
  syncing,
  error,
  onSync,
}: {
  models: string[]
  syncing: boolean
  error?: string
  onSync: () => void
}) {
  const { t } = useTranslation('settings')
  return (
    <div className="settings-provider-model-catalog">
      <div className={cn('settings-provider-metadata', error && 'is-error')} role={error ? 'alert' : undefined}>
        <span>{error
          ? <><AlertTriangle className="mr-2 inline size-4" />{t('models.syncFailed', { error })}</>
          : t('models.kitionHostedModelsReady')}</span>
        <Button size="sm" variant="outline" onClick={onSync} disabled={syncing}>
          <RefreshCcw className={cn('mr-2 size-4', syncing && 'animate-spin')} />
          {syncing ? t('models.syncing') : error ? t('models.retry') : t('models.syncNow')}
        </Button>
      </div>
      {models.length ? (
        <ul className="settings-provider-model-list" data-testid="kition-cloud-model-list">
          {models.map((model) => <li key={model}>{model}</li>)}
        </ul>
      ) : syncing ? null : (
        <p className="settings-provider-model-empty">{t('models.noModelsReturned')}</p>
      )}
    </div>
  )
}

export function AiModelsPane() {
  const { t } = useTranslation('settings')
  const kitionAccount = useKitionAccount()
  const kitionAccountLinks = getKitionAccountLinks(kitionAccount.state.session)
  const [settings, setSettings] = useState<DesktopSettingsState | null>(null)
  const [pristineSettings, setPristineSettings] = useState<DesktopSettingsState | null>(null)
  const [activeKind, setActiveKind] = useState<DesktopProviderKind>('kition_console')
  const [syncing, setSyncing] = useState(false)
  const [syncError, setSyncError] = useState<string | undefined>(undefined)
  const [cloudSyncing, setCloudSyncing] = useState(false)
  const [cloudSyncError, setCloudSyncError] = useState<string | undefined>(undefined)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [disconnectError, setDisconnectError] = useState<string | undefined>(undefined)
  const [providerSearch, setProviderSearch] = useState('')

  useEffect(() => {
    loadDesktopSettings().then((value) => {
      setSettings(value)
      setPristineSettings(value)
      setActiveKind(value.models.activeProvider)
    })
  }, [])

  useEffect(() => {
    setSyncing(false)
    setSyncError(undefined)
  }, [activeKind])

  const settingsLoaded = Boolean(settings)
  const accountStatus = kitionAccount.state.status
  useEffect(() => {
    if (!settingsLoaded || !isKitionAccountUsable(accountStatus)) return
    let cancelled = false
    setCloudSyncing(true)
    setCloudSyncError(undefined)
    loadDesktopSettings()
      .then((current) => syncProviderModelCatalog(
        current,
        'kition_console',
        t('models.noModelsReturned'),
        false,
      ))
      .then((persisted) => {
        if (cancelled) return
        setSettings(persisted)
        setPristineSettings(persisted)
      })
      .catch((error) => {
        if (!cancelled) setCloudSyncError(error instanceof Error ? error.message : t('models.unknownError'))
      })
      .finally(() => {
        if (!cancelled) setCloudSyncing(false)
      })
    return () => {
      cancelled = true
    }
  }, [accountStatus, settingsLoaded, t])

  if (!settings || !pristineSettings) {
    return <div className="settings-pane"><p className="text-sm text-muted-foreground">{t('models.loading')}</p></div>
  }

  const catalogEntry = desktopProviderCatalog.find((p) => p.kind === activeKind)!
  const dirty = !isPristine(settings.providers, pristineSettings.providers) ||
                !isPristine(settings.models, pristineSettings.models)

  const activeProvider = settings.providers[activeKind]
  const providerQuery = providerSearch.trim().toLowerCase()
  const visibleProviders = providerQuery
    ? desktopProviderCatalog.filter((provider) => (
      `${provider.label} ${provider.sublabel} ${provider.descriptor}`.toLowerCase().includes(providerQuery)
    ))
    : desktopProviderCatalog
  function updateProvider(patch: Partial<typeof activeProvider>) {
    setSettings((current) => current && ({
      ...current,
      providers: { ...current.providers, [activeKind]: { ...current.providers[activeKind], ...patch } },
    }))
  }

  const activeSettings = settings
  const activePristine = pristineSettings

  async function handleSave() {
    await saveDesktopSettings(activeSettings)
    setPristineSettings(activeSettings)
  }
  function handleCancel() {
    setSettings(activePristine)
  }
  async function handleSync() {
    if (!settings) return
    setSyncing(true)
    setSyncError(undefined)
    try {
      const persisted = await syncProviderModelCatalog(
        settings,
        activeKind,
        t('models.noModelsReturned'),
        true,
      )
      setSettings(persisted)
      setPristineSettings(persisted)
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : t('models.unknownError'))
    } finally {
      setSyncing(false)
    }
  }

  async function handleCloudSync() {
    setCloudSyncing(true)
    setCloudSyncError(undefined)
    try {
      const persisted = await syncProviderModelCatalog(
        settings,
        'kition_console',
        t('models.noModelsReturned'),
        false,
      )
      setSettings(persisted)
      setPristineSettings(persisted)
    } catch (error) {
      setCloudSyncError(error instanceof Error ? error.message : t('models.unknownError'))
    } finally {
      setCloudSyncing(false)
    }
  }

  async function handleDisconnect() {
    if (!settings) return
    setDisconnecting(true)
    setDisconnectError(undefined)
    try {
      if (activeKind === 'kition_console') {
        await kitionAccount.logout()
        const next = await loadDesktopSettings()
        setSettings(next)
        setPristineSettings(next)
        setConfirmDisconnect(false)
        return
      }
      const next: DesktopSettingsState = {
        ...settings,
        providers: {
          ...settings.providers,
          [activeKind]: { ...activeProvider, enabled: false, apiKey: '', accessToken: '' },
        },
      }
      await saveDesktopSettings(next)
      setSettings(next)
      setPristineSettings(next)
      setConfirmDisconnect(false)
    } catch (err) {
      setDisconnectError(err instanceof Error ? err.message : t('models.unknownError'))
    } finally {
      setDisconnecting(false)
    }
  }

  return (
    <div className="settings-pane">
      <SettingsPaneHeader title={t('models.paneTitle')} description={t('models.paneDescription')} />

      <SettingsSection title={t('models.providersSection')}>
        <div className="settings-provider-layout">
          <aside className="settings-provider-rail">
            <label className="settings-provider-search">
              <Search className="size-4" aria-hidden="true" />
              <input
                type="search"
                value={providerSearch}
                onChange={(event) => setProviderSearch(event.target.value)}
                placeholder="Search providers"
                aria-label="Search AI providers"
              />
            </label>
            {visibleProviders.map((provider) => {
              const current = settings.providers[provider.kind]
              const connected = provider.kind === 'kition_console'
                ? isKitionAccountUsable(kitionAccount.state.status)
                : current.enabled
              return (
                <button
                  key={provider.kind}
                  type="button"
                  className={cn('settings-provider-row', activeKind === provider.kind && 'is-active')}
                  onClick={() => setActiveKind(provider.kind)}
                >
                  <span className={cn('settings-provider-dot', connected && 'is-on')} />
                  <span className="settings-provider-name">
                    <strong>{provider.label}</strong>
                    <em>{provider.sublabel}</em>
                  </span>
                </button>
              )
            })}
            {!visibleProviders.length ? <p className="px-3 py-4 text-sm text-muted-foreground">No providers found.</p> : null}
            <Button variant="ghost" className="settings-provider-add"><Plus className="size-4" />{t('models.addCustom')}</Button>
          </aside>
          <div className="settings-provider-editor">
            <header className="settings-provider-editor-head">
              <h3>{catalogEntry.label}</h3>
              <p>{catalogEntry.descriptor}</p>
            </header>
            <SettingsSection title={t('models.connectionSection')}>
              <ProviderConnectionFields
                kind={activeKind}
                provider={activeProvider}
                onPatch={updateProvider}
                kitionAccount={kitionAccount.state}
                onKitionAccountConnect={() => void kitionAccount.ensureReady()}
                onKitionAccountCancel={kitionAccount.cancelConnect}
                onKitionAccountTopup={() => void openExternalURL(kitionAccountLinks.topup)}
              />
            </SettingsSection>
            {activeKind === 'kition_console' ? null : (
              <Disclosure title={t('models.advancedSection')}>
                <ProviderAdvancedFields
                  kind={activeKind}
                  provider={activeProvider}
                  onPatch={updateProvider}
                />
              </Disclosure>
            )}
            {activeKind === 'kition_console' ? (
              isKitionAccountUsable(kitionAccount.state.status) ? (
                <KitionCloudModelCatalog
                  models={activeProvider.discoveredModels || []}
                  syncing={cloudSyncing}
                  error={cloudSyncError}
                  onSync={() => void handleCloudSync()}
                />
              ) : (
                <div className="settings-provider-metadata">
                  <span>{kitionAccount.state.status === 'credits_empty'
                    ? t('models.kitionHostedModelsTopup')
                    : t('models.kitionHostedModelsSignIn')}</span>
                </div>
              )
            ) : (
              <ProviderMetadataRow
                count={activeProvider.discoveredModels?.length ?? 0}
                lastSyncedAt={activeProvider.lastSyncedAt}
                syncing={syncing}
                error={syncError}
                onSync={handleSync}
                onRetry={handleSync}
              />
            )}
          </div>
        </div>
      </SettingsSection>

      <SettingsActionBar
        dirty={dirty}
        onSave={handleSave}
        onCancel={handleCancel}
        saveLabel={t('models.saveProvider')}
        destructive={
          (activeKind === 'kition_console'
            ? isKitionAccountAuthenticated(kitionAccount.state.status)
            : activeProvider.enabled) ? (
            <Button variant="ghost" className="text-destructive" onClick={() => setConfirmDisconnect(true)}>
              {t('models.disconnect')}
            </Button>
          ) : undefined
        }
      />
      {confirmDisconnect ? (
        <DisconnectConfirmDialog
          providerName={catalogEntry.label}
          pending={disconnecting}
          error={disconnectError}
          onCancel={() => { setConfirmDisconnect(false); setDisconnectError(undefined) }}
          onConfirm={handleDisconnect}
        />
      ) : null}
    </div>
  )
}
