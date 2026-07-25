import { Save, Search } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { Button, Input, PasswordInput } from '@/components/ui'
import { ConnectionsSettingsPanel } from '@/features/connections/ConnectionsSettingsPanel'
import { useConfirm } from '@/components/confirm'
import { deleteConnection, type ConnectionView } from '@/features/connections/api'
import { ProviderSwitch } from '@/features/emailSync/EmailSyncSettingsPanel'
import {
  deleteEmailSyncWorkflow,
  listEmailSyncWorkflows,
  type EmailSyncWorkflow,
} from '@/features/emailSync/api'
import { SettingsPaneHeader } from '@/features/settings/primitives'
import { cn } from '@/lib/utils'
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
  const [workflows, setWorkflows] = useState<EmailSyncWorkflow[]>([])
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

  const workflowByProvider = useMemo(() => {
    const map = new Map<EmailProviderId, EmailSyncWorkflow>()
    for (const workflow of workflows) {
      const providerId = resolveEmailProviderId('imap', workflow.connection.host, workflow.connection.username)
      if (!map.has(providerId)) map.set(providerId, workflow)
    }
    return map
  }, [workflows])

  const workflowsByProvider = useMemo(() => {
    const map = new Map<EmailProviderId, EmailSyncWorkflow[]>()
    for (const workflow of workflows) {
      const providerId = resolveEmailProviderId('imap', workflow.connection.host, workflow.connection.username)
      map.set(providerId, [...(map.get(providerId) || []), workflow])
    }
    return map
  }, [workflows])

  const connectionByProvider = useMemo(() => {
    const map = new Map<EmailProviderId, ConnectionView>()
    for (const connection of connections) {
      const providerId = resolveEmailProviderId('smtp', String(connection.settings.host || ''), String(connection.settings.username || ''))
      if (!map.has(providerId)) map.set(providerId, connection)
    }
    return map
  }, [connections])

  const selectedProvider = getEmailProvider(selectedProviderId)
  const selectedWorkflow = workflowByProvider.get(selectedProviderId)
  const selectedConnection = connectionByProvider.get(selectedProviderId)
  const configuredUsername = selectedWorkflow?.connection.username
    || String(selectedConnection?.settings.username || selectedConnection?.settings.from || '')
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
    void listEmailSyncWorkflows().then(setWorkflows).catch(() => setWorkflows([]))
  }, [])

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
      resolveEmailProviderId('smtp', String(connection.settings.host || ''), String(connection.settings.username || '')) === current
    )) ? null : current)
  }, [])

  async function toggleProvider(providerId: EmailProviderId) {
    setSelectedProviderId(providerId)
    setAccountSaved(false)
    const providerWorkflows = workflowsByProvider.get(providerId) || []
    const connection = connectionByProvider.get(providerId)
    if (!providerWorkflows.length && !connection && !storedCredentials[providerId]) {
      setPendingEnabledProviderId((current) => current === providerId ? null : providerId)
      return
    }
    if (!(await confirm({
      message: `Disconnect ${getEmailProvider(providerId).label}? Inbox Sync and Email Delivery settings for this provider will be removed. Imported files remain in the workspace.`,
      variant: 'destructive',
    }))) return
    setToggleBusy(providerId)
    try {
      await Promise.all([
        ...providerWorkflows.map((workflow) => deleteEmailSyncWorkflow(workflow.id)),
        connection ? deleteConnection(connection.id, { force: true }) : Promise.resolve(),
      ])
      const workflowIds = new Set(providerWorkflows.map((workflow) => workflow.id))
      setWorkflows((current) => current.filter((item) => !workflowIds.has(item.id)))
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
        description="Store provider credentials once. Inbox synchronization is configured and monitored from table workflows."
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
              const workflow = workflowByProvider.get(provider.id)
              const connection = connectionByProvider.get(provider.id)
              const enabled = Boolean(
                workflow
                || connection
                || storedCredentials[provider.id]
                || pendingEnabledProviderId === provider.id,
              )
              const account = workflow?.connection.username
                || String(connection?.settings.username || connection?.settings.from || '')
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
                    <span className={cn('settings-provider-dot', (workflow || connection || storedCredentials[provider.id]) && 'is-on')} />
                    <span className="settings-provider-name min-w-0">
                      <strong className="truncate">{provider.label}</strong>
                      <em className="truncate">{account || storedUsernames[provider.id] || provider.credentialLabel}</em>
                    </span>
                  </button>
                  <ProviderSwitch
                    checked={enabled}
                    disabled={toggleBusy === provider.id}
                    label={`${enabled ? 'Disconnect' : 'Connect'} ${provider.label}`}
                    onChange={() => void toggleProvider(provider.id)}
                  />
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
              <Input
                value={accountDraft.username}
                onChange={(event) => updateAccount({ username: event.target.value })}
                placeholder={selectedProvider.accountHint}
                data-testid="email-provider-account-username"
              />
            </label>
            <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
              <span>{selectedProvider.credentialLabel}</span>
              <PasswordInput
                value={accountDraft.password}
                onChange={(event) => updateAccount({ password: event.target.value })}
                placeholder={storedCredential || selectedWorkflow || selectedConnection ? 'Stored credential' : selectedProvider.credentialLabel}
                data-testid="email-provider-account-password"
              />
            </label>
            <p className="text-xs text-muted-foreground">Stored once in Kition's local credential store and reused by Inbox Sync and Email Delivery.</p>
            <div className="flex items-center gap-3">
              <Button disabled={!accountDraft.username.trim()} onClick={() => void acceptCredential()}>
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
