import { SaveIcon as Save, SearchIcon as Search } from '@kition/tessera-icons/react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { cn } from '@/lib/cn'
import { Button, PasswordInput, TextInput, useConfirm } from '@kition/tessera-ui'
import { ConnectionsSettingsPanel } from '@/features/connections/ConnectionsSettingsPanel'
import { deleteConnection, type ConnectionView } from '@/api/connections'
import { SettingsPaneHeader } from '@/features/settings/primitives'
import { getSecureValue, setSecureValue } from '@/services/desktop'
import {
  emailProviderCatalog,
  getEmailProvider,
  resolveEmailProviderId,
  type EmailProviderId,
} from './emailProviderCatalog'
import {
  emailProviderCredentialKey,
  emailProviderUsernameKey,
} from './emailProviderAccount'

type AccountDraft = { username: string; password: string }

export function EmailProvidersPane() {
  const [selectedProviderId, setSelectedProviderId] = useState<EmailProviderId>('gmail')
  const [search, setSearch] = useState('')
  const [toggleBusy, setToggleBusy] = useState<EmailProviderId | null>(null)
  const [pendingEnabledProviderId, setPendingEnabledProviderId] = useState<EmailProviderId | null>(null)
  const [connections, setConnections] = useState<ConnectionView[]>([])
  const [accountDrafts, setAccountDrafts] = useState<Partial<Record<EmailProviderId, AccountDraft>>>({})
  const [storedCredentials, setStoredCredentials] = useState<Partial<Record<EmailProviderId, string>>>({})
  const [storedUsernames, setStoredUsernames] = useState<Partial<Record<EmailProviderId, string>>>({})
  const [accountSaved, setAccountSaved] = useState(false)
  const confirm = useConfirm()

  const visibleProviders = useMemo(() => {
    const query = search.trim().toLowerCase()
    return query
      ? emailProviderCatalog.filter((provider) => (
        `${provider.label} ${provider.credentialLabel} ${provider.credentialHint}`.toLowerCase().includes(query)
      ))
      : emailProviderCatalog
  }, [search])

  const connectionByProvider = useMemo(() => {
    const map = new Map<EmailProviderId, ConnectionView>()
    for (const connection of connections) {
      const providerId = resolveEmailProviderId(String(connection.settings.host || ''), String(connection.settings.username || ''))
      if (!map.has(providerId)) map.set(providerId, connection)
    }
    return map
  }, [connections])

  const selectedProvider = getEmailProvider(selectedProviderId)
  const selectedConnection = connectionByProvider.get(selectedProviderId)
  const configuredUsername = String(selectedConnection?.settings.username || selectedConnection?.settings.from || '')
    || storedUsernames[selectedProviderId]
    || ''
  const accountDraft = accountDrafts[selectedProviderId] || { username: configuredUsername, password: '' }
  const storedCredential = storedCredentials[selectedProviderId] || ''

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      getSecureValue(emailProviderCredentialKey(selectedProviderId)).catch(() => ''),
      getSecureValue(emailProviderUsernameKey(selectedProviderId)).catch(() => ''),
    ]).then(([credential, username]) => {
      if (cancelled) return
      if (credential) setStoredCredentials((current) => ({ ...current, [selectedProviderId]: credential }))
      if (username) setStoredUsernames((current) => ({ ...current, [selectedProviderId]: username }))
    })
    return () => { cancelled = true }
  }, [selectedProviderId])

  useEffect(() => {
    if (!configuredUsername) return
    setAccountDrafts((current) => {
      const existing = current[selectedProviderId]
      if (existing?.username) return current
      return { ...current, [selectedProviderId]: { username: configuredUsername, password: existing?.password || '' } }
    })
  }, [configuredUsername, selectedProviderId])

  const handleConnectionsChange = useCallback((nextConnections: ConnectionView[]) => {
    setConnections(nextConnections)
    setPendingEnabledProviderId((current) => current && nextConnections.some((connection) => (
      resolveEmailProviderId(String(connection.settings.host || ''), String(connection.settings.username || '')) === current
    )) ? null : current)
  }, [])

  async function toggleProvider(providerId: EmailProviderId) {
    setSelectedProviderId(providerId)
    setAccountSaved(false)
    const connection = connectionByProvider.get(providerId)
    if (!connection && !storedCredentials[providerId]) {
      setPendingEnabledProviderId((current) => current === providerId ? null : providerId)
      return
    }
    if (!(await confirm({
      message: `Disconnect ${getEmailProvider(providerId).label}? Email Delivery settings for this provider will be removed.`,
      variant: 'danger',
    }))) return
    setToggleBusy(providerId)
    try {
      if (connection) await deleteConnection(connection.id, { force: true })
      if (connection) setConnections((current) => current.filter((item) => item.id !== connection.id))
      await Promise.all([
        setSecureValue(emailProviderCredentialKey(providerId), ''),
        setSecureValue(emailProviderUsernameKey(providerId), ''),
      ])
      setStoredCredentials((current) => ({ ...current, [providerId]: '' }))
      setStoredUsernames((current) => ({ ...current, [providerId]: '' }))
    } finally {
      setToggleBusy(null)
    }
  }

  function updateAccount(patch: Partial<AccountDraft>) {
    setAccountSaved(false)
    setAccountDrafts((current) => ({
      ...current,
      [selectedProviderId]: { ...accountDraft, ...patch },
    }))
  }

  async function acceptCredential() {
    const nextUsername = accountDraft.username.trim()
    await setSecureValue(emailProviderUsernameKey(selectedProviderId), nextUsername)
    setStoredUsernames((current) => ({ ...current, [selectedProviderId]: nextUsername }))
    if (accountDraft.password) {
      await setSecureValue(emailProviderCredentialKey(selectedProviderId), accountDraft.password)
      setStoredCredentials((current) => ({ ...current, [selectedProviderId]: accountDraft.password }))
    }
    setAccountDrafts((current) => ({
      ...current,
      [selectedProviderId]: { ...accountDraft, password: '' },
    }))
    setAccountSaved(true)
  }

  const sharedAccount = {
    username: accountDraft.username,
    password: accountDraft.password || storedCredential,
    hasStoredCredential: Boolean(storedCredential),
    onCredentialAccepted: acceptCredential,
  }

  return (
    <div className="settings-pane" data-testid="email-providers-pane">
      <SettingsPaneHeader
        title="Email Providers"
        description="Store provider credentials once for send-email workflow actions."
      />

      <div className="settings-provider-layout email-provider-center">
        <aside className="settings-provider-rail" aria-label="Email providers">
          <label className="settings-provider-search">
            <Search className="size-4" aria-hidden="true" />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search providers"
              aria-label="Search email providers"
            />
          </label>

          <div className="grid gap-1">
            {visibleProviders.map((provider) => {
              const connection = connectionByProvider.get(provider.id)
              const enabled = Boolean(
                connection
                || storedCredentials[provider.id]
                || pendingEnabledProviderId === provider.id,
              )
              const account = String(connection?.settings.username || connection?.settings.from || '')
              const active = selectedProviderId === provider.id
              return (
                <div key={provider.id} className={cn('email-provider-row', active && 'is-active')}>
                  <button
                    type="button"
                    className="email-provider-select"
                    onClick={() => {
                      setSelectedProviderId(provider.id)
                      setAccountSaved(false)
                    }}
                    data-testid={`email-provider-row-${provider.id}`}
                  >
                    <span className={cn('settings-provider-dot', (connection || storedCredentials[provider.id]) && 'is-on')} />
                    <span className="settings-provider-name min-w-0">
                      <strong className="truncate">{provider.label}</strong>
                      <em className="truncate">{account || storedUsernames[provider.id] || provider.credentialLabel}</em>
                    </span>
                  </button>
                  <span className={cn('el-switch', enabled && 'is-checked')}>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={enabled}
                      aria-label={`${enabled ? 'Disconnect' : 'Connect'} ${provider.label}`}
                      disabled={toggleBusy === provider.id}
                      className="settings-switch-button"
                      onClick={() => void toggleProvider(provider.id)}
                    />
                  </span>
                </div>
              )
            })}
            {!visibleProviders.length ? <p className="px-3 py-4 text-sm text-muted-foreground">No providers found.</p> : null}
          </div>
        </aside>

        <div className="settings-provider-editor min-w-0">
          <header className="border-b border-border pb-5">
            <p className="text-xs font-semibold uppercase text-muted-foreground">Email account</p>
            <h2 className="mt-1 text-xl font-semibold text-foreground">{selectedProvider.label}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{selectedProvider.credentialHint}</p>
          </header>

          <section className="grid gap-3 border-b border-border py-5" aria-label={`${selectedProvider.label} account`}>
            <h3 className="text-sm font-semibold text-foreground">Account credentials</h3>
            <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
              <span>Email address or account</span>
              <TextInput size="lg"
                value={accountDraft.username}
                onChange={(event) => updateAccount({ username: event.target.value })}
                placeholder={selectedProvider.accountHint}
                data-testid="email-provider-account-username"
              />
            </label>
            <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
              <span>{selectedProvider.credentialLabel}</span>
              <PasswordInput size="lg"
                value={accountDraft.password}
                onChange={(event) => updateAccount({ password: event.target.value })}
                placeholder={storedCredential || selectedConnection ? 'Stored credential' : selectedProvider.credentialLabel}
                data-testid="email-provider-account-password"
              />
            </label>
            <p className="text-xs text-muted-foreground">Stored once in Kition's local credential store and reused by Email Delivery.</p>
            <div className="flex items-center gap-3">
              <Button size="md" variant="primary" disabled={!accountDraft.username.trim()} onClick={() => void acceptCredential()}>
                <Save className="size-4" />
                Save account
              </Button>
              {accountSaved ? <span className="text-xs text-success">Account saved.</span> : null}
            </div>
          </section>

          <div className="py-5">
            <div className="mb-4">
              <h3 className="text-sm font-semibold text-foreground">Email Delivery</h3>
              <p className="mt-1 text-sm text-muted-foreground">Configure SMTP for send-email workflow actions.</p>
            </div>
            <ConnectionsSettingsPanel
              embedded
              providerId={selectedProviderId}
              sharedAccount={sharedAccount}
              onConnectionsChange={handleConnectionsChange}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
