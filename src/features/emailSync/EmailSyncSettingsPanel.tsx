import {
  AlertCircle,
  Inbox,
  ListRestart,
  LoaderCircle,
  Play,
  RefreshCw,
  RotateCcw,
  Trash2,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'

import { useConfirm } from '@/components/confirm'
import { Button, Disclosure, Input, PasswordInput } from '@/components/ui'
import {
  getEmailProvider,
  resolveEmailProviderId,
  type EmailProviderId,
} from '@/features/emailProviders/emailProviderCatalog'
import { EMAIL_AUTOMATION_TABLE_PATH } from '@/features/onboarding/upgradeOnboardingPack'
import { getDesktopBackendStatus, type DesktopBackendStatus } from '@/services/desktop'
import {
  createEmailSyncWorkflow,
  deleteEmailSyncWorkflow,
  EMAIL_SYNC_CHANGED_EVENT,
  listEmailSyncWorkflows,
  startEmailSyncRun,
  testEmailSyncWorkflow,
  updateEmailSyncWorkflow,
  type EmailSyncTlsMode,
  type EmailSyncWorkflow,
  type SaveEmailSyncWorkflowInput,
} from './api'
import { consumeEmailSyncSetupRequest } from './setupRequest'
import type { SharedEmailProviderAccount } from '@/features/emailProviders/emailProviderAccount'
import { normalizeEmailSyncTablePath } from './useTableEmailSyncWorkflows'
import { EmailSyncTableSelect } from './EmailSyncTableSelect'
import { useEmailSyncTableOptions } from './useEmailSyncTableOptions'
import { CopyableEmailSyncError } from './CopyableEmailSyncError'

type FormState = {
  id?: string
  providerId: EmailProviderId
  name: string
  host: string
  port: string
  tlsMode: EmailSyncTlsMode
  username: string
  password: string
  mailbox: string
  tablePath: string
  tableId: string
  contentFolder: string
  attachmentFolder: string
  intervalMinutes: string
  enabled: boolean
  includeAttachments: boolean
}

type EmailSyncSettingsPanelProps = {
  providerId?: EmailProviderId
  enableByDefault?: boolean
  defaultIntervalMinutes?: number
  requestedTablePath?: string
  sharedAccount?: SharedEmailProviderAccount
  onWorkflowsChange?: (workflows: EmailSyncWorkflow[]) => void
  onSaved?: (workflow: EmailSyncWorkflow) => void
  onCancel?: () => void
  showHeader?: boolean
  showRunActions?: boolean
  showSchedule?: boolean
}

export function runtimeSupportsEmailSync(status: DesktopBackendStatus | null): boolean {
  return Boolean(status?.capabilities?.includes('email_sync'))
}

export function EmailSyncSettingsPanel({
  providerId = 'gmail',
  enableByDefault = false,
  defaultIntervalMinutes = 15,
  requestedTablePath: requestedTablePathProp,
  sharedAccount,
  onWorkflowsChange,
  onSaved,
  onCancel,
  showHeader = true,
  showRunActions = true,
  showSchedule = true,
}: EmailSyncSettingsPanelProps) {
  const confirm = useConfirm()
  const provider = getEmailProvider(providerId)
  const [supported, setSupported] = useState<boolean | null>(null)
  const [workflows, setWorkflows] = useState<EmailSyncWorkflow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [feedback, setFeedback] = useState('')
  const [requestedTablePath] = useState(() => (
    requestedTablePathProp || consumeEmailSyncSetupRequest()?.tablePath || ''
  ))
  const [form, setForm] = useState<FormState>(() => (
    emptyForm(providerId, requestedTablePath, enableByDefault, defaultIntervalMinutes)
  ))
  const {
    options: destinationTables,
    loading: destinationTablesLoading,
    error: destinationTablesError,
  } = useEmailSyncTableOptions(form.tablePath)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const backendStatus = await getDesktopBackendStatus().catch(() => null)
      const nextSupported = runtimeSupportsEmailSync(backendStatus)
      setSupported(nextSupported)
      if (!nextSupported) {
        setWorkflows([])
        onWorkflowsChange?.([])
        return
      }
      const nextWorkflows = await listEmailSyncWorkflows()
      setWorkflows(nextWorkflows)
      onWorkflowsChange?.(nextWorkflows)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to load inbox providers')
    } finally {
      setLoading(false)
    }
  }, [onWorkflowsChange])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    const onChanged = () => void refresh()
    window.addEventListener(EMAIL_SYNC_CHANGED_EVENT, onChanged)
    return () => window.removeEventListener(EMAIL_SYNC_CHANGED_EVENT, onChanged)
  }, [refresh])

  const workflow = useMemo(() => {
    const providerWorkflows = workflows.filter((item) => (
      resolveEmailProviderId('imap', item.connection.host, item.connection.username) === providerId
    ))
    if (!requestedTablePath) return providerWorkflows[0] || null
    const requestedPath = normalizeEmailSyncTablePath(requestedTablePath)
    return providerWorkflows.find((item) => (
      normalizeEmailSyncTablePath(item.target.table_path) === requestedPath
    )) || null
  }, [providerId, requestedTablePath, workflows])
  const syncInProgress = workflow?.status === 'syncing'

  useEffect(() => {
    setError('')
    setForm(workflow
      ? formFromWorkflow(workflow)
      : emptyForm(providerId, requestedTablePath, enableByDefault, defaultIntervalMinutes))
  }, [defaultIntervalMinutes, enableByDefault, providerId, requestedTablePath, workflow])

  useEffect(() => {
    if (form.tableId || !destinationTables[0]) return
    setForm((current) => current.tableId ? current : { ...current, tableId: String(destinationTables[0].id) })
  }, [destinationTables, form.tableId])

  const effectiveUsername = sharedAccount?.username ?? form.username
  const effectivePassword = sharedAccount?.password ?? form.password
  const selectedTableId = Number(form.tableId)
  const selectedDestinationTable = destinationTables.find((table) => table.id === selectedTableId) || null

  const canSubmit = Boolean(
    form.host.trim()
    && Number(form.port) > 0
    && effectiveUsername.trim()
    && form.mailbox.trim()
    && form.tablePath.trim().endsWith('.kitable')
    && selectedDestinationTable
    && form.contentFolder.trim()
    && form.attachmentFolder.trim()
    && Number(form.intervalMinutes) >= 5
    && (form.id || effectivePassword.trim()),
  )

  async function save() {
    setBusy('save')
    setError('')
    setFeedback('')
    const transport = resolveInboxTransport(form)
    const input: SaveEmailSyncWorkflowInput = {
      name: form.name.trim() || `${provider.label} inbox`,
      connection: {
        host: transport.host,
        port: transport.port,
        tls_mode: transport.tlsMode,
        username: effectiveUsername.trim(),
        mailbox: form.mailbox.trim(),
      },
      target: {
        table_path: form.tablePath.trim(),
        table_id: selectedTableId,
        content_folder: form.contentFolder.trim(),
        attachment_folder: form.attachmentFolder.trim(),
      },
      schedule: {
        enabled: form.enabled,
        interval_minutes: Number(form.intervalMinutes),
      },
      include_attachments: form.includeAttachments,
      ...(effectivePassword.trim() ? { password: effectivePassword } : {}),
    }
    try {
      const saved = form.id
        ? await updateEmailSyncWorkflow(form.id, input)
        : await createEmailSyncWorkflow(input)
      await sharedAccount?.onCredentialAccepted()
      setFeedback(`Connected ${saved.connection.username}.`)
      await refresh()
      onSaved?.(saved)
    } catch (requestError) {
      setError(formatEmailSyncError(requestError, provider.label))
    } finally {
      setBusy('')
    }
  }

  async function toggleEnabled() {
    if (!workflow) {
      setForm((current) => ({ ...current, enabled: !current.enabled }))
      return
    }
    setBusy('toggle')
    setError('')
    try {
      await updateEmailSyncWorkflow(workflow.id, {
        schedule: { ...workflow.schedule, enabled: !workflow.schedule.enabled },
      })
      await refresh()
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to update inbox provider')
    } finally {
      setBusy('')
    }
  }

  async function runAction(action: 'test' | 'sync' | 'sync-all') {
    if (!workflow) return
    setBusy(action)
    setError('')
    setFeedback('')
    try {
      if (action === 'test') {
        const result = await testEmailSyncWorkflow(workflow.id)
        setFeedback(result.ok ? `Connection verified for ${result.mailbox || workflow.connection.mailbox}.` : result.message || 'Connection test failed.')
      } else {
        await startEmailSyncRun(workflow.id, action === 'sync-all' ? 'full' : 'incremental')
        setFeedback(`${action === 'sync-all' ? 'Full sync' : 'Sync'} started. Progress and results are available on the corresponding workflow.`)
        await refresh()
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : `${action} failed`)
    } finally {
      setBusy('')
    }
  }

  async function remove() {
    if (!workflow) return
    if (!(await confirm({
      message: `Disconnect ${provider.label}? Imported tables and Markdown documents will remain in the workspace.`,
      variant: 'destructive',
    }))) return
    setBusy('delete')
    setError('')
    try {
      await deleteEmailSyncWorkflow(workflow.id)
      setFeedback('')
      await refresh()
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to disconnect inbox provider')
    } finally {
      setBusy('')
    }
  }

  if (loading && supported === null) {
    return <StatusNotice icon={<LoaderCircle className="size-4 animate-spin" />} text="Loading inbox provider" />
  }

  if (supported === false) {
    return (
      <StatusNotice
        icon={<AlertCircle className="size-4" />}
        text="The active runtime does not provide the email_sync capability. Update the runtime before configuring inbox sync."
      />
    )
  }

  return (
    <section className="min-w-0" data-testid="email-sync-settings-panel">
      {showHeader ? (
        <header className="flex items-start justify-between gap-4 border-b border-border pb-5">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase text-muted-foreground">Inbox Sync</p>
            <h2 className="mt-1 text-lg font-semibold text-foreground">Synchronization settings</h2>
            <p className="mt-1 text-sm text-muted-foreground">Import messages into a Kitable and keep readable Markdown copies.</p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <span className="text-xs font-medium text-muted-foreground">{workflow?.schedule.enabled || (!workflow && form.enabled) ? 'Enabled' : 'Disabled'}</span>
            <ProviderSwitch
              checked={Boolean(workflow?.schedule.enabled || (!workflow && form.enabled))}
              disabled={busy !== ''}
              label={`Enable ${provider.label} inbox sync`}
              onChange={() => void toggleEnabled()}
            />
          </div>
        </header>
      ) : null}

      {error ? <CopyableEmailSyncError message={error} className="mt-4" testId="email-sync-error" /> : null}
      {feedback ? <div className="mt-4 rounded-lg border border-success/40 bg-success/10 px-3 py-2 text-sm text-success" data-testid="email-sync-feedback" role="status">{feedback}</div> : null}
      {workflow?.last_error ? <CopyableEmailSyncError message={workflow.last_error} className="mt-4" testId="email-sync-workflow-error" /> : null}

      {workflow ? (
        <dl className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3 rounded-lg border border-border bg-surface-soft px-4 py-3 text-sm" data-testid="email-sync-status-summary">
          <StatusItem
            label="Destination table"
            value={selectedDestinationTable?.title || (workflow.target.table_id ? `Table ${workflow.target.table_id}` : tableName(workflow.target.table_path))}
          />
          <StatusItem label="Messages synced" value={String(workflow.synced_messages)} />
          <StatusItem label="Last sync" value={formatSyncTime(workflow.last_sync_at)} />
          <StatusItem label="Status" value={formatSyncStatus(workflow.status)} />
        </dl>
      ) : null}

      {isNetEaseMailboxProvider(providerId) ? (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-border bg-surface-soft px-3 py-2.5 text-xs text-muted-foreground" data-testid="email-sync-mailbox-scope-note">
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-warning" />
          <p>
            <span className="font-medium text-foreground">Mailbox history is controlled by {provider.label}.</span>{' '}
            Sync all imports every message exposed to IMAP for {form.mailbox.trim() || 'INBOX'}. In webmail settings, open POP3, SMTP, and IMAP and set the client receive range to all messages.
          </p>
        </div>
      ) : null}

      <div className="grid gap-6 py-5">
        {!sharedAccount ? (
          <FormSection title="Mailbox account">
            <FormField label="Email address or account">
              <Input value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} placeholder={provider.accountHint} data-testid="email-sync-username" />
            </FormField>
            <FormField label={provider.credentialLabel}>
              <PasswordInput value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder={form.id ? 'Leave blank to keep the stored credential' : provider.credentialLabel} data-testid="email-sync-password" />
            </FormField>
          </FormSection>
        ) : null}

        <FormSection title="Workspace destination">
          <FormControl label="Destination table">
            <EmailSyncTableSelect
              value={selectedTableId > 0 ? selectedTableId : null}
              options={destinationTables}
              loading={destinationTablesLoading}
              disabled={busy !== ''}
              kitablePath={form.tablePath}
              onChange={(tableId) => setForm({ ...form, tableId: String(tableId) })}
            />
            {destinationTablesError ? <p className="text-xs text-destructive" role="alert">{destinationTablesError}</p> : null}
          </FormControl>
        </FormSection>

        {showSchedule ? (
          <FormSection title="Schedule">
            <FormField label="Automatic sync">
              <select
                className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
                value={form.enabled ? form.intervalMinutes : 'manual'}
                onChange={(event) => setForm({
                  ...form,
                  enabled: event.target.value !== 'manual',
                  intervalMinutes: event.target.value === 'manual' ? form.intervalMinutes : event.target.value,
                })}
                data-testid="email-sync-schedule"
              >
                <option value="manual">Manual only</option>
                <option value="5">Every 5 minutes</option>
                <option value="15">Every 15 minutes</option>
                <option value="30">Every 30 minutes</option>
                <option value="60">Every hour</option>
                <option value="360">Every 6 hours</option>
                <option value="1440">Every day</option>
              </select>
            </FormField>
            <CheckField checked={form.includeAttachments} onChange={(includeAttachments) => setForm({ ...form, includeAttachments })} label="Download attachments into the workspace" />
          </FormSection>
        ) : (
          <CheckField checked={form.includeAttachments} onChange={(includeAttachments) => setForm({ ...form, includeAttachments })} label="Download attachments into the workspace" />
        )}

        <Disclosure title="Advanced" defaultOpen={providerId === 'custom'}>
          <div className="grid gap-3 pt-3">
            {providerId !== 'custom' ? (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-soft px-3 py-2 text-xs text-muted-foreground">
                <span>IMAP {provider.imap.host}:{provider.imap.port} · {provider.imap.tlsMode.toUpperCase()}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setForm({
                    ...form,
                    host: provider.imap.host,
                    port: String(provider.imap.port),
                    tlsMode: provider.imap.tlsMode,
                  })}
                >
                  <RotateCcw className="size-3.5" />
                  Use defaults
                </Button>
              </div>
            ) : null}
            <FormField label="Connection name"><Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder={`${provider.label} inbox`} data-testid="email-sync-name" /></FormField>
            <div className="grid grid-cols-[minmax(0,1fr)_110px] gap-3">
              <FormField label="IMAP host"><Input value={form.host} onChange={(event) => setForm({ ...form, host: event.target.value })} placeholder="imap.example.com" data-testid="email-sync-host" /></FormField>
              <FormField label="Port"><Input value={form.port} onChange={(event) => setForm({ ...form, port: event.target.value })} inputMode="numeric" data-testid="email-sync-port" /></FormField>
            </div>
            <div className="grid grid-cols-[150px_minmax(0,1fr)] gap-3">
              <FormField label="TLS">
                <select className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground" value={form.tlsMode} onChange={(event) => setForm({ ...form, tlsMode: event.target.value as EmailSyncTlsMode })} data-testid="email-sync-tls">
                  <option value="tls">TLS</option>
                  <option value="starttls">STARTTLS</option>
                  <option value="plain">Plain</option>
                </select>
              </FormField>
              <FormField label="Mailbox"><Input value={form.mailbox} onChange={(event) => setForm({ ...form, mailbox: event.target.value })} data-testid="email-sync-mailbox" /></FormField>
            </div>
            <FormField label="Markdown folder"><Input value={form.contentFolder} onChange={(event) => setForm({ ...form, contentFolder: event.target.value })} data-testid="email-sync-content-folder" /></FormField>
            <FormField label="Attachment folder"><Input value={form.attachmentFolder} onChange={(event) => setForm({ ...form, attachmentFolder: event.target.value })} data-testid="email-sync-attachment-folder" /></FormField>
          </div>
        </Disclosure>
      </div>

      <footer className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
        <Button disabled={!canSubmit || busy !== ''} onClick={() => void save()} data-testid="email-sync-save">
          {busy === 'save' ? <LoaderCircle className="size-4 animate-spin" /> : null}
          Save workflow
        </Button>
        {workflow && showRunActions ? (
          <>
            <Button variant="outline" disabled={busy !== '' || syncInProgress} onClick={() => void runAction('sync')} data-testid="email-sync-run">
              {busy === 'sync' ? <LoaderCircle className="size-4 animate-spin" /> : <Play className="size-4" />}
              Sync now
            </Button>
            <Button variant="outline" disabled={busy !== '' || syncInProgress} onClick={() => void runAction('sync-all')} data-testid="email-sync-run-all">
              {busy === 'sync-all' ? <LoaderCircle className="size-4 animate-spin" /> : <ListRestart className="size-4" />}
              Sync all
            </Button>
            <Button variant="ghost" size="icon" className="ml-auto text-destructive hover:text-destructive" disabled={busy !== ''} onClick={() => void remove()} aria-label={`Disconnect ${provider.label}`}>
              {busy === 'delete' ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
            </Button>
          </>
        ) : null}
        {workflow ? <Button variant="outline" disabled={busy !== '' || syncInProgress} onClick={() => void runAction('test')}>Test</Button> : null}
        {onCancel ? <Button variant="ghost" onClick={onCancel}>Cancel</Button> : null}
        <Button variant="ghost" size="icon" className="ml-auto" disabled={loading} onClick={() => void refresh()} aria-label="Refresh inbox providers">
          <RefreshCw className={loading ? 'size-4 animate-spin' : 'size-4'} />
        </Button>
      </footer>
    </section>
  )
}

export function ProviderSwitch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean
  disabled?: boolean
  label: string
  onChange: () => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`relative h-6 w-11 shrink-0 rounded-full border transition-colors ${checked ? 'border-primary bg-primary' : 'border-border bg-muted'} disabled:opacity-50`}
      onClick={onChange}
    >
      <span className={`absolute left-0 top-0.5 size-[18px] rounded-full bg-white shadow-sm transition-transform ${checked ? 'translate-x-[20px]' : 'translate-x-0.5'}`} />
    </button>
  )
}

function StatusNotice({ icon, text }: { icon: ReactNode; text: string }) {
  return <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">{icon}<span>{text}</span></div>
}

function FormSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="grid gap-3"><h3 className="text-sm font-semibold text-foreground">{title}</h3>{children}</section>
}

function FormField({ label, children }: { label: string; children: ReactNode }) {
  return <label className="grid min-w-0 gap-1.5 text-xs font-medium text-muted-foreground"><span>{label}</span>{children}</label>
}

function FormControl({ label, children }: { label: string; children: ReactNode }) {
  return <div className="grid min-w-0 gap-1.5 text-xs font-medium text-muted-foreground"><span>{label}</span>{children}</div>
}

function CheckField({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return <label className="flex items-center gap-2 text-sm text-foreground"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />{label}</label>
}

function StatusItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate font-medium text-foreground" title={value}>{value}</dd>
    </div>
  )
}

function formatSyncTime(value?: string) {
  if (!value) return 'Never'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function formatSyncStatus(status: EmailSyncWorkflow['status']) {
  return status.charAt(0).toUpperCase() + status.slice(1)
}

function formatEmailSyncError(error: unknown, providerLabel: string): string {
  const message = error instanceof Error ? error.message : 'Failed to save inbox provider'
  if (message.includes('unknown tag "220"') || message.includes('IMAP greeting')) {
    return `${providerLabel} returned an SMTP greeting. Inbox Sync must use the IMAP host and port. Open Advanced and choose Use defaults.`
  }
  return message
}

function resolveInboxTransport(form: FormState): { host: string; port: number; tlsMode: EmailSyncTlsMode } {
  const provider = getEmailProvider(form.providerId)
  const host = form.host.trim()
  const port = Number(form.port)
  const usesSmtpPreset = form.providerId !== 'custom' && (
    host === provider.smtp.host
    || (host === provider.imap.host && port === provider.smtp.port && provider.smtp.port !== provider.imap.port)
  )
  return usesSmtpPreset
    ? { host: provider.imap.host, port: provider.imap.port, tlsMode: provider.imap.tlsMode }
    : { host, port, tlsMode: form.tlsMode }
}

function emptyForm(
  providerId: EmailProviderId,
  tablePath = '',
  enabled = false,
  intervalMinutes = 15,
): FormState {
  const provider = getEmailProvider(providerId)
  return {
    providerId,
    name: '',
    host: provider.imap.host,
    port: String(provider.imap.port),
    tlsMode: provider.imap.tlsMode,
    username: '',
    password: '',
    mailbox: 'INBOX',
    tablePath: tablePath || EMAIL_AUTOMATION_TABLE_PATH,
    tableId: '',
    contentFolder: 'Mail/Messages',
    attachmentFolder: 'Mail/Attachments',
    intervalMinutes: String(intervalMinutes),
    enabled,
    includeAttachments: true,
  }
}

function formFromWorkflow(workflow: EmailSyncWorkflow): FormState {
  return {
    id: workflow.id,
    providerId: resolveEmailProviderId('imap', workflow.connection.host, workflow.connection.username),
    name: workflow.name,
    host: workflow.connection.host,
    port: String(workflow.connection.port),
    tlsMode: workflow.connection.tls_mode,
    username: workflow.connection.username,
    password: '',
    mailbox: workflow.connection.mailbox,
    tablePath: workflow.target.table_path,
    tableId: workflow.target.table_id ? String(workflow.target.table_id) : '',
    contentFolder: workflow.target.content_folder,
    attachmentFolder: workflow.target.attachment_folder,
    intervalMinutes: String(workflow.schedule.interval_minutes),
    enabled: workflow.schedule.enabled,
    includeAttachments: workflow.include_attachments,
  }
}

function tableName(path: string) {
  return path.split(/[\\/]/).pop()?.replace(/\.kitable$/i, '') || 'Inbox'
}

function isNetEaseMailboxProvider(providerId: EmailProviderId) {
  return providerId === '163' || providerId === '126'
}
