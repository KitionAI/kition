import { LoaderCircle, Mail, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, Disclosure, Input, PasswordInput } from '@/components/ui'
import { useConfirm } from '@/components/confirm'
import {
  emailProviderCatalog,
  getEmailProvider,
  resolveEmailProviderId,
  type EmailProviderId,
} from '@/features/emailProviders/emailProviderCatalog'
import {
  createConnection,
  deleteConnection,
  listChannels,
  listConnections,
  testConnection,
  updateConnection,
  type ChannelSchema,
  type ConnectionView,
} from '@/features/connections/api'
import type { SharedEmailProviderAccount } from '@/features/emailProviders/emailProviderAccount'

type ConnectionFormState = {
  id?: string
  providerId: EmailProviderId
  name: string
  host: string
  port: string
  username: string
  password: string
  tlsMode: string
  from: string
  fromName: string
}

export function ConnectionsSettingsPanel({
  embedded = false,
  providerId = 'gmail',
  sharedAccount,
  onConnectionsChange,
}: {
  embedded?: boolean
  providerId?: EmailProviderId
  sharedAccount?: SharedEmailProviderAccount
  onConnectionsChange?: (connections: ConnectionView[]) => void
} = {}) {
  const { t } = useTranslation('connections')
  const [channels, setChannels] = useState<ChannelSchema[]>([])
  const [connections, setConnections] = useState<ConnectionView[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [status, setStatus] = useState<'loading' | 'done' | 'error'>('loading')
  const [error, setError] = useState('')
  const [modal, setModal] = useState<ConnectionFormState | null>(null)

  async function refresh() {
    setStatus('loading')
    setError('')
    try {
      const [nextChannels, nextConnections] = await Promise.all([listChannels(), listConnections()])
      const channelList = Array.isArray(nextChannels) ? nextChannels : []
      const connectionList = Array.isArray(nextConnections) ? nextConnections : []
      setChannels(channelList)
      setConnections(connectionList)
      onConnectionsChange?.(connectionList)
      setSelectedId((current) => connectionList.some((item) => item.id === current) ? current : connectionList[0]?.id || '')
      setStatus('done')
    } catch (requestError) {
      setStatus('error')
      setError(requestError instanceof Error ? requestError.message : t('errors.loadFailed'))
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const selected = useMemo(
    () => connections.find((item) => item.id === selectedId) || null,
    [connections, selectedId],
  )
  const emailChannel = channels.find((item) => item.channel === 'email_smtp')
  const providerConnection = connections.find((connection) => (
    resolveEmailProviderId('smtp', String(connection.settings.host || ''), String(connection.settings.username || '')) === providerId
  ))

  if (embedded) {
    return (
      <section className="min-w-0" data-testid="connections-settings-panel">
        {status === 'loading' ? (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            {t('panel.loading')}
          </div>
        ) : null}
        {status === 'error' ? <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div> : null}
        {status === 'done' ? (
          <ConnectionModal
            key={`${providerId}:${providerConnection?.id || 'new'}`}
            channel={emailChannel}
            initial={providerConnection ? formFromConnection(providerConnection) : undefined}
            providerId={providerId}
            embedded
            sharedAccount={sharedAccount}
            onClose={() => undefined}
            onSaved={async () => {
              await refresh()
            }}
          />
        ) : null}
      </section>
    )
  }

  return (
    <section className="settings-section" data-testid="connections-settings-panel">
      <header className="settings-section-header">
        <div>
          <p className="settings-eyebrow">{t('panel.eyebrow')}</p>
          <h2>{t('panel.title')}</h2>
          <p>{t('panel.subtitle')}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void refresh()} aria-label={t('panel.refreshAria')}>
            <RefreshCw className="size-4" />
          </Button>
          <Button size="sm" onClick={() => setModal(emptyForm())} data-testid="connection-new">
            <Plus className="size-4" />
            {t('panel.newConnection')}
          </Button>
        </div>
      </header>

      {status === 'loading' ? (
        <div className="mt-4 flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" />
          {t('panel.loading')}
        </div>
      ) : null}
      {status === 'error' ? (
        <div className="mt-4 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div>
      ) : null}

      {status === 'done' ? (
        <div className="mt-5 grid min-h-[360px] grid-cols-[minmax(260px,360px)_1fr] gap-4">
          <div className="grid content-start gap-2">
            {connections.length ? connections.map((connection) => (
              <button
                key={connection.id}
                type="button"
                className={`rounded-xl border bg-card p-3 text-left shadow-sm transition-colors ${selectedId === connection.id ? 'border-primary ring-2 ring-primary/30' : 'border-border hover:bg-muted/40'}`}
                onClick={() => setSelectedId(connection.id)}
                data-testid="connection-card"
              >
                <div className="flex items-start gap-3">
                  <span className="inline-grid size-8 shrink-0 place-items-center rounded-lg border border-border/60 bg-tint-peach text-foreground">
                    <Mail className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-foreground">{connection.name}</span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">{String(connection.settings.from || connection.settings.host || t('panel.fallbackEmailSmtp'))}</span>
                    <span className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                      <StatusBadge status={connection.status} />
                      {t('panel.usedBy', { count: connection.usedByCount || 0 })}
                    </span>
                  </span>
                </div>
              </button>
            )) : (
              <div className="rounded-xl border border-dashed border-border bg-card px-4 py-8 text-center">
                <Mail className="mx-auto mb-3 size-7 text-primary" />
                <div className="text-sm font-semibold text-foreground">{t('panel.emptyTitle')}</div>
                <p className="mt-1 text-xs text-muted-foreground">{t('panel.emptyHint')}</p>
                <Button size="sm" className="mt-4" onClick={() => setModal(emptyForm())}>
                  {t('panel.emptyCta')}
                </Button>
              </div>
            )}
          </div>

          <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
            {selected ? (
              <ConnectionDetail
                connection={selected}
                onEdit={() => setModal(formFromConnection(selected))}
                onDelete={async () => {
                  // Server-side guard re-confirms via 409 if anything
                  // changed between confirm and request; passing
                  // force=true lets the deletion proceed once the user
                  // has acknowledged the used-by count in the dialog.
                  await deleteConnection(selected.id, { force: true })
                  await refresh()
                }}
                onTest={async () => {
                  await testConnection(selected.id)
                  await refresh()
                }}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{t('panel.pickPrompt')}</div>
            )}
          </div>
        </div>
      ) : null}

      {modal ? (
        <ConnectionModal
          channel={emailChannel}
          initial={modal}
          onClose={() => setModal(null)}
          onSaved={async (connection) => {
            setModal(null)
            await refresh()
            setSelectedId(connection.id)
          }}
        />
      ) : null}
    </section>
  )
}

export function ConnectionModal({
  channel,
  initial,
  providerId = 'gmail',
  embedded = false,
  sharedAccount,
  onClose,
  onSaved,
}: {
  channel?: ChannelSchema
  initial?: ConnectionFormState
  providerId?: EmailProviderId
  embedded?: boolean
  sharedAccount?: SharedEmailProviderAccount
  onClose: () => void
  onSaved: (connection: ConnectionView) => void | Promise<void>
}) {
  const { t } = useTranslation('connections')
  const [form, setForm] = useState<ConnectionFormState>(() => initial || emptyForm(providerId))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [okMessage, setOkMessage] = useState('')
  const provider = getEmailProvider(form.providerId)
  const effectiveUsername = sharedAccount?.username ?? form.username
  const effectivePassword = sharedAccount?.password ?? form.password
  // Holds the pending auto-close timer after a successful save so we can
  // clear it if the modal unmounts before it fires (e.g. user closes the
  // dialog manually during the success toast).
  const autoCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (autoCloseTimerRef.current !== null) {
      clearTimeout(autoCloseTimerRef.current)
      autoCloseTimerRef.current = null
    }
  }, [])
  const schemaTlsOptions = channel?.fields.find((field) => field.key === 'tlsMode')?.options || []
  const tlsOptions = [
    { value: 'starttls', label: 'STARTTLS' },
    { value: 'tls', label: 'TLS' },
    { value: 'plain', label: 'Plain' },
  ].map((fallback) => schemaTlsOptions.find((option) => option.value === fallback.value) || fallback)

  async function submit() {
    if (autoCloseTimerRef.current !== null) return // Save already succeeded; close is pending.
    setSaving(true)
    setError('')
    setOkMessage('')
    let saved: ConnectionView
    try {
      const payload = {
        channel: 'email_smtp',
        name: form.name.trim() || `${provider.label} delivery`,
        settings: {
          host: form.host.trim(),
          port: Number(form.port || 587),
          username: effectiveUsername.trim(),
          tlsMode: form.tlsMode,
          from: form.from.trim() || effectiveUsername.trim(),
          fromName: form.fromName.trim(),
        },
        secrets: effectivePassword.trim() ? { password: effectivePassword } : undefined,
      }
      // Both endpoints test the connection server-side before returning.
      // The response's `status` / `lastErrorCode` fields tell us whether
      // verification passed — no need for a second roundtrip.
      saved = form.id
        ? await updateConnection(form.id, payload)
        : await createConnection({ ...payload, secrets: { password: effectivePassword } })
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t('errors.saveFailed'))
      setSaving(false)
      return
    }
    if (saved.status === 'invalid') {
      // Keep the modal open so the user can fix credentials and retry.
      setError(saved.lastErrorMessage || t('errors.verifyFailedFallback'))
      setSaving(false)
      return
    }
    if (embedded) {
      await sharedAccount?.onCredentialAccepted()
      setOkMessage(t('feedback.verified'))
      setSaving(false)
      await onSaved(saved)
      return
    }
    // Show the success toast, then let the parent close us after a brief
    // pause. `saving` stays true so the action button keeps its spinner
    // and the user can't double-submit while the close is pending.
    setOkMessage(t('feedback.verified'))
    autoCloseTimerRef.current = setTimeout(() => {
      autoCloseTimerRef.current = null
      void onSaved(saved)
    }, 1200)
  }

  const canSubmit = Boolean(form.host.trim() && form.port.trim() && effectiveUsername.trim() && (form.id || effectivePassword.trim()))

  const editor = (
      <div className={embedded ? 'min-w-0' : 'w-full max-w-[560px] overflow-hidden rounded-xl border border-border bg-card shadow-2xl'}>
        <header className="flex items-center gap-3 border-b border-border px-5 py-4">
          <Mail className="size-5 text-primary" />
          <div>
            <p className="text-xs font-semibold uppercase text-muted-foreground">Email Delivery</p>
            <h3 className={embedded ? 'mt-1 text-lg font-semibold text-foreground' : 'text-sm font-semibold text-foreground'}>{embedded ? 'Delivery settings' : form.id ? t('modal.titleEdit') : t('modal.titleNew')}</h3>
            <p className="text-xs text-muted-foreground">{embedded ? 'Configure sender identity and SMTP transport for send-email workflows.' : t('modal.subtitle')}</p>
          </div>
          {!embedded ? (
            <button type="button" className="ml-auto inline-grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground" onClick={onClose} aria-label={t('modal.closeAria')}>
              <X className="size-4" />
            </button>
          ) : null}
        </header>
        <div className="grid gap-5 px-5 py-4">
          {!embedded ? <FormField label="Email provider">
            <select
              className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
              value={form.providerId}
              onChange={(event) => {
                const providerId = event.target.value as EmailProviderId
                const nextProvider = getEmailProvider(providerId)
                setForm({
                  ...form,
                  providerId,
                  host: nextProvider.smtp.host,
                  port: String(nextProvider.smtp.port),
                  tlsMode: nextProvider.smtp.tlsMode,
                })
              }}
              data-testid="connection-provider"
            >
              {emailProviderCatalog.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </FormField> : null}
          {!sharedAccount ? <div className="rounded-lg border border-border bg-surface-soft px-3 py-2 text-xs text-muted-foreground">
            {provider.credentialHint}
          </div> : null}
          {!sharedAccount ? <>
            <FormField label="Email address or account"><Input value={form.username} placeholder={provider.accountHint} onChange={(event) => setForm({ ...form, username: event.target.value })} data-testid="connection-username" /></FormField>
            <FormField label={provider.credentialLabel}>
              <PasswordInput value={form.password} placeholder={form.id ? t('modal.passwordPlaceholderEdit') : provider.credentialLabel} onChange={(event) => setForm({ ...form, password: event.target.value })} data-testid="connection-password" />
            </FormField>
          </> : null}
          <FormField label={t('modal.fieldFromName')}><Input value={form.fromName} placeholder={t('modal.fromNamePlaceholder')} onChange={(event) => setForm({ ...form, fromName: event.target.value })} data-testid="connection-from-name" /></FormField>

          <Disclosure title="Advanced" defaultOpen={form.providerId === 'custom'}>
            <div className="grid gap-3 pt-3">
              <FormField label={t('modal.fieldName')}><Input value={form.name} placeholder={`${provider.label} delivery`} onChange={(event) => setForm({ ...form, name: event.target.value })} data-testid="connection-name" /></FormField>
              <div className="grid grid-cols-[1fr_120px] gap-3">
                <FormField label={t('modal.fieldHost')}><Input value={form.host} placeholder={t('modal.hostPlaceholder')} onChange={(event) => setForm({ ...form, host: event.target.value })} data-testid="connection-host" /></FormField>
                <FormField label={t('modal.fieldPort')}><Input value={form.port} placeholder={t('modal.portPlaceholder')} onChange={(event) => setForm({ ...form, port: event.target.value })} data-testid="connection-port" /></FormField>
              </div>
              <div className="grid grid-cols-[160px_1fr] gap-3">
                <FormField label={t('modal.fieldTls')}>
                  <select className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/30" value={form.tlsMode} onChange={(event) => setForm({ ...form, tlsMode: event.target.value })} data-testid="connection-tls">
                    {tlsOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </FormField>
                <FormField label={t('modal.fieldFromAddress')}><Input type="email" value={form.from} placeholder="Defaults to the account address" onChange={(event) => setForm({ ...form, from: event.target.value })} data-testid="connection-from" /></FormField>
              </div>
            </div>
          </Disclosure>
          {error ? <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive" data-testid="connection-error">{error}</div> : null}
          {okMessage ? <div className="rounded-lg border border-success/40 bg-success/10 px-3 py-2 text-xs text-success">{okMessage}</div> : null}
        </div>
        <footer className="flex justify-end gap-2 border-t border-border bg-muted/40 px-5 py-4">
          {!embedded ? <Button variant="outline" onClick={onClose}>{t('modal.cancel')}</Button> : null}
          <Button disabled={!canSubmit || saving} onClick={() => void submit()} data-testid="connection-save">
            {saving ? <LoaderCircle className="size-4 animate-spin" /> : null}
            {t('modal.testAndSave')}
          </Button>
        </footer>
      </div>
  )

  if (embedded) return editor

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/25 p-4" role="dialog" aria-modal="true" aria-label={t('modal.ariaLabel')}>
      {editor}
    </div>
  )
}

function ConnectionDetail({ connection, onEdit, onDelete, onTest }: {
  connection: ConnectionView
  onEdit: () => void
  onDelete: () => Promise<void>
  onTest: () => Promise<void>
}) {
  const { t } = useTranslation('connections')
  const confirm = useConfirm()
  const [busy, setBusy] = useState<'test' | 'delete' | ''>('')
  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground/80">{t('detail.eyebrowEmailSmtp')}</div>
          <h3 className="mt-1 text-lg font-semibold text-foreground">{connection.name}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{String(connection.settings.from || '')} via {String(connection.settings.host || '')}</p>
        </div>
        <StatusBadge status={connection.status} />
      </div>
      <dl className="mt-5 grid grid-cols-2 gap-3 text-sm">
        <DetailItem label={t('detail.labelHost')} value={`${String(connection.settings.host || '')}:${String(connection.settings.port || '')}`} />
        <DetailItem label={t('detail.labelTls')} value={String(connection.settings.tlsMode || 'starttls')} />
        <DetailItem label={t('detail.labelUsername')} value={String(connection.settings.username || '')} />
        <DetailItem label={t('detail.labelUsedBy')} value={t('detail.usedByWorkflows', { count: connection.usedByCount || 0 })} />
      </dl>
      {connection.lastErrorMessage ? (
        <div className="mt-4 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{connection.lastErrorMessage}</div>
      ) : null}
      <div className="mt-6 flex gap-2">
        <Button variant="outline" onClick={onEdit}>{t('detail.edit')}</Button>
        <Button
          variant="outline"
          onClick={async () => {
            setBusy('test')
            try { await onTest() } finally { setBusy('') }
          }}
          disabled={busy !== ''}
        >
          {busy === 'test' ? <LoaderCircle className="size-4 animate-spin" /> : null}
          {t('detail.test')}
        </Button>
        <Button
          variant="outline"
          className="ml-auto text-destructive hover:text-destructive"
          onClick={async () => {
            const used = connection.usedByCount || 0
            const message = used > 0
              ? t('confirms.deleteWithUsage', { name: connection.name, count: used })
              : t('confirms.deleteNoUsage', { name: connection.name })
            if (!(await confirm({ message, variant: 'destructive' }))) return
            setBusy('delete')
            try { await onDelete() } finally { setBusy('') }
          }}
          disabled={busy !== ''}
        >
          {busy === 'delete' ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
          {t('detail.delete')}
        </Button>
      </div>
    </div>
  )
}

function FormField({ label, children }: { label: string; children: ReactNode }) {
  return <label className="grid gap-1.5 text-xs font-medium text-muted-foreground"><span>{label}</span>{children}</label>
}

function DetailItem({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-border bg-muted/40 px-3 py-2"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 truncate font-medium text-foreground">{value || '-'}</dd></div>
}

function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation('connections')
  const className = status === 'active'
    ? 'bg-success/15 text-success border border-success/30'
    : status === 'invalid'
      ? 'bg-destructive/15 text-destructive border border-destructive/30'
      : 'bg-muted text-muted-foreground border border-border'
  const label = status === 'active' ? t('status.active') : status === 'invalid' ? t('status.invalid') : t('status.pending')
  return <span className={`inline-flex rounded-lg px-2 py-0.5 text-[11px] font-semibold ${className}`}>{label}</span>
}

function emptyForm(providerId: EmailProviderId = 'gmail'): ConnectionFormState {
  const provider = getEmailProvider(providerId)
  return {
    providerId: provider.id,
    name: '',
    host: provider.smtp.host,
    port: String(provider.smtp.port),
    username: '',
    password: '',
    tlsMode: provider.smtp.tlsMode,
    from: '',
    fromName: '',
  }
}

export function formFromConnection(connection: ConnectionView): ConnectionFormState {
  return {
    id: connection.id,
    providerId: resolveEmailProviderId('smtp', String(connection.settings.host || ''), String(connection.settings.username || '')),
    name: connection.name,
    host: String(connection.settings.host || ''),
    port: String(connection.settings.port || '587'),
    username: String(connection.settings.username || ''),
    password: '',
    tlsMode: String(connection.settings.tlsMode || 'starttls'),
    from: String(connection.settings.from || ''),
    fromName: String(connection.settings.fromName || ''),
  }
}
