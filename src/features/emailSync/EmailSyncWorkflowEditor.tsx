import { ArrowLeft, Mail } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { Button, Input, PasswordInput } from '@/components/ui'
import {
  emailProviderCatalog,
  getEmailProvider,
  resolveEmailProviderId,
  type EmailProviderId,
} from '@/features/emailProviders/emailProviderCatalog'
import {
  emailProviderCredentialKey,
  emailProviderUsernameKey,
} from '@/features/emailProviders/emailProviderAccount'
import { getSecureValue, setSecureValue } from '@/services/desktop'
import { listEmailSyncWorkflows, type EmailSyncWorkflow } from './api'
import { EmailSyncSettingsPanel } from './EmailSyncSettingsPanel'

export function EmailSyncWorkflowEditor({
  tablePath,
  workflow,
  onSaved,
  onCancel,
  layout = 'page',
  showSchedule = true,
  enableByDefault = false,
  defaultIntervalMinutes = 15,
  runAfterSave,
}: {
  tablePath: string
  workflow?: EmailSyncWorkflow | null
  onSaved: (workflow: EmailSyncWorkflow) => void
  onCancel: () => void
  layout?: 'page' | 'panel'
  showSchedule?: boolean
  enableByDefault?: boolean
  defaultIntervalMinutes?: number
  runAfterSave?: 'full'
}) {
  const initialProviderId = workflow
    ? resolveEmailProviderId('imap', workflow.connection.host, workflow.connection.username)
    : 'gmail'
  const [providerId, setProviderId] = useState<EmailProviderId>(initialProviderId)
  const [username, setUsername] = useState(workflow?.connection.username || '')
  const [password, setPassword] = useState('')
  const [storedCredential, setStoredCredential] = useState('')
  const [knownWorkflows, setKnownWorkflows] = useState<EmailSyncWorkflow[]>(workflow ? [workflow] : [])
  const [providerInitialized, setProviderInitialized] = useState(Boolean(workflow))
  const provider = getEmailProvider(providerId)

  useEffect(() => {
    void listEmailSyncWorkflows().then(setKnownWorkflows).catch(() => undefined)
  }, [])

  useEffect(() => {
    if (providerInitialized || !knownWorkflows.length) return
    const hasCurrentProvider = knownWorkflows.some((item) => (
      resolveEmailProviderId('imap', item.connection.host, item.connection.username) === providerId
    ))
    if (!hasCurrentProvider) {
      setProviderId(resolveEmailProviderId(
        'imap',
        knownWorkflows[0].connection.host,
        knownWorkflows[0].connection.username,
      ))
    }
    setProviderInitialized(true)
  }, [knownWorkflows, providerId, providerInitialized])

  useEffect(() => {
    let active = true
    void Promise.all([
      getSecureValue(emailProviderUsernameKey(providerId)).catch(() => ''),
      getSecureValue(emailProviderCredentialKey(providerId)).catch(() => ''),
    ]).then(([storedUsername, credential]) => {
      if (!active) return
      const knownUsername = knownWorkflows.find((item) => (
        resolveEmailProviderId('imap', item.connection.host, item.connection.username) === providerId
      ))?.connection.username
      setUsername(workflow && providerId === initialProviderId
        ? workflow.connection.username
        : storedUsername || knownUsername || '')
      setStoredCredential(credential || '')
      setPassword('')
    })
    return () => { active = false }
  }, [initialProviderId, knownWorkflows, providerId, workflow])

  const sharedAccount = useMemo(() => ({
    username,
    password: password || storedCredential,
    hasStoredCredential: Boolean(storedCredential),
    onCredentialAccepted: async () => {
      await setSecureValue(emailProviderUsernameKey(providerId), username.trim())
      if (password) {
        await setSecureValue(emailProviderCredentialKey(providerId), password)
        setStoredCredential(password)
        setPassword('')
      }
    },
  }), [password, providerId, storedCredential, username])

  return (
    <div className={layout === 'page' ? 'h-full overflow-auto bg-background' : ''} data-testid="email-sync-workflow-editor" data-layout={layout}>
      {layout === 'page' ? (
        <header className="sticky top-0 z-10 border-b border-border bg-background/95 px-6 py-4 backdrop-blur">
          <div className="mx-auto flex max-w-4xl items-center gap-3">
            <Button variant="ghost" size="icon" onClick={onCancel} aria-label="Back to workflows">
              <ArrowLeft className="size-4" />
            </Button>
            <div>
              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <Mail className="size-3.5" />
                Email sync workflow
              </div>
              <h1 className="mt-1 text-xl font-semibold text-foreground">
                {workflow ? 'Edit inbox sync' : 'Create inbox sync'}
              </h1>
            </div>
          </div>
        </header>
      ) : null}

      <main className={`${layout === 'page' ? 'mx-auto max-w-4xl px-6 py-6' : ''} grid gap-6`}>
        <section className="grid gap-4 border-b border-border pb-6">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Mailbox account</h2>
            <p className="mt-1 text-sm text-muted-foreground">Choose the provider account used by this workflow.</p>
          </div>
          <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
            <span>Provider</span>
            <select
              className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground"
              value={providerId}
              disabled={Boolean(workflow)}
              onChange={(event) => setProviderId(event.target.value as EmailProviderId)}
              data-testid="email-sync-workflow-provider"
            >
              {emailProviderCatalog.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
              <span>Email address or account</span>
              <Input value={username} onChange={(event) => setUsername(event.target.value)} placeholder={provider.accountHint} />
            </label>
            <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
              <span>{provider.credentialLabel}</span>
              <PasswordInput
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={storedCredential || workflow ? 'Stored credential' : provider.credentialLabel}
              />
            </label>
          </div>
        </section>

        <EmailSyncSettingsPanel
          key={`${providerId}:${tablePath}:${workflow?.id || 'new'}`}
          providerId={providerId}
          requestedTablePath={tablePath}
          sharedAccount={sharedAccount}
          onSaved={onSaved}
          onCancel={onCancel}
          showHeader={false}
          showRunActions={false}
          showSchedule={showSchedule}
          enableByDefault={enableByDefault}
          defaultIntervalMinutes={defaultIntervalMinutes}
          runAfterSave={runAfterSave}
        />
      </main>
    </div>
  )
}
