import { LoaderCircleIcon as LoaderCircle, MailIcon as Mail, XIcon as X } from '@kition/tessera-icons/react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, Disclosure, PasswordInput, TextInput } from '@kition/tessera-ui'
import {
  createConnection,
  updateConnection,
  type ChannelSchema,
  type ConnectionView,
} from '@/api/connections'
import {
  emailProviderCatalog,
  getEmailProvider,
  resolveEmailProviderId,
  type EmailProviderId,
} from './emailProviderCatalog'

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

/** Creates or edits the SMTP connection a workflow's Send email action sends through. */
export function ConnectionModal({
  channel,
  initial,
  onClose,
  onSaved,
}: {
  channel?: ChannelSchema
  initial?: ConnectionFormState
  onClose: () => void
  onSaved: (connection: ConnectionView) => void | Promise<void>
}) {
  const { t } = useTranslation('connections')
  const [form, setForm] = useState<ConnectionFormState>(() => initial || emptyForm())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [okMessage, setOkMessage] = useState('')
  const provider = getEmailProvider(form.providerId)
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
          username: form.username.trim(),
          tlsMode: form.tlsMode,
          from: form.from.trim() || form.username.trim(),
          fromName: form.fromName.trim(),
        },
        secrets: form.password.trim() ? { password: form.password } : undefined,
      }
      // Both endpoints test the connection server-side before returning.
      // The response's `status` / `lastErrorCode` fields tell us whether
      // verification passed — no need for a second roundtrip.
      saved = form.id
        ? await updateConnection(form.id, payload)
        : await createConnection({ ...payload, secrets: { password: form.password } })
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
    // Show the success toast, then let the parent close us after a brief
    // pause. `saving` stays true so the action button keeps its spinner
    // and the user can't double-submit while the close is pending.
    setOkMessage(t('feedback.verified'))
    autoCloseTimerRef.current = setTimeout(() => {
      autoCloseTimerRef.current = null
      void onSaved(saved)
    }, 1200)
  }

  const canSubmit = Boolean(form.host.trim() && form.port.trim() && form.username.trim() && (form.id || form.password.trim()))

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/25 p-4" role="dialog" aria-modal="true" aria-label={t('modal.ariaLabel')}>
      <div className="w-full max-w-[560px] overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
        <header className="flex items-center gap-3 border-b border-border px-5 py-4">
          <Mail className="size-5 text-primary" />
          <div>
            <p className="text-xs font-semibold uppercase text-muted-foreground">Email Delivery</p>
            <h3 className="text-sm font-semibold text-foreground">{form.id ? t('modal.titleEdit') : t('modal.titleNew')}</h3>
            <p className="text-xs text-muted-foreground">{t('modal.subtitle')}</p>
          </div>
          <button type="button" className="ml-auto inline-grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground" onClick={onClose} aria-label={t('modal.closeAria')}>
            <X className="size-4" />
          </button>
        </header>
        <div className="grid gap-5 px-5 py-4">
          <FormField label="Email provider">
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
          </FormField>
          <div className="rounded-lg border border-border bg-surface-soft px-3 py-2 text-xs text-muted-foreground">
            {provider.credentialHint}
          </div>
          <FormField label="Email address or account"><TextInput size="lg" value={form.username} placeholder={provider.accountHint} onChange={(event) => setForm({ ...form, username: event.target.value })} data-testid="connection-username" /></FormField>
          <FormField label={provider.credentialLabel}>
            <PasswordInput size="lg" value={form.password} placeholder={form.id ? t('modal.passwordPlaceholderEdit') : provider.credentialLabel} onChange={(event) => setForm({ ...form, password: event.target.value })} data-testid="connection-password" />
          </FormField>
          <FormField label={t('modal.fieldFromName')}><TextInput size="lg" value={form.fromName} placeholder={t('modal.fromNamePlaceholder')} onChange={(event) => setForm({ ...form, fromName: event.target.value })} data-testid="connection-from-name" /></FormField>

          <Disclosure title="Advanced" defaultOpen={form.providerId === 'custom'}>
            <div className="grid gap-3 pt-3">
              <FormField label={t('modal.fieldName')}><TextInput size="lg" value={form.name} placeholder={`${provider.label} delivery`} onChange={(event) => setForm({ ...form, name: event.target.value })} data-testid="connection-name" /></FormField>
              <div className="grid grid-cols-[1fr_120px] gap-3">
                <FormField label={t('modal.fieldHost')}><TextInput size="lg" value={form.host} placeholder={t('modal.hostPlaceholder')} onChange={(event) => setForm({ ...form, host: event.target.value })} data-testid="connection-host" /></FormField>
                <FormField label={t('modal.fieldPort')}><TextInput size="lg" value={form.port} placeholder={t('modal.portPlaceholder')} onChange={(event) => setForm({ ...form, port: event.target.value })} data-testid="connection-port" /></FormField>
              </div>
              <div className="grid grid-cols-[160px_1fr] gap-3">
                <FormField label={t('modal.fieldTls')}>
                  <select className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/30" value={form.tlsMode} onChange={(event) => setForm({ ...form, tlsMode: event.target.value })} data-testid="connection-tls">
                    {tlsOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </FormField>
                <FormField label={t('modal.fieldFromAddress')}><TextInput size="lg" type="email" value={form.from} placeholder="Defaults to the account address" onChange={(event) => setForm({ ...form, from: event.target.value })} data-testid="connection-from" /></FormField>
              </div>
            </div>
          </Disclosure>
          {error ? <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive" data-testid="connection-error">{error}</div> : null}
          {okMessage ? <div className="rounded-lg border border-success/40 bg-success/10 px-3 py-2 text-xs text-success">{okMessage}</div> : null}
        </div>
        <footer className="flex justify-end gap-2 border-t border-border bg-muted/40 px-5 py-4">
          <Button size="md" variant="secondary" onClick={onClose}>{t('modal.cancel')}</Button>
          <Button size="md" variant="primary" disabled={!canSubmit || saving} onClick={() => void submit()} data-testid="connection-save">
            {saving ? <LoaderCircle className="size-4 animate-spin" /> : null}
            {t('modal.testAndSave')}
          </Button>
        </footer>
      </div>
    </div>
  )
}

function FormField({ label, children }: { label: string; children: ReactNode }) {
  return <label className="grid gap-1.5 text-xs font-medium text-muted-foreground"><span>{label}</span>{children}</label>
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
    providerId: resolveEmailProviderId(String(connection.settings.host || ''), String(connection.settings.username || '')),
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
