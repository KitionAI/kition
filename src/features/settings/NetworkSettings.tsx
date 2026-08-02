import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Globe, Network, ShieldAlert } from 'lucide-react'
import { Button, Input, PasswordInput, Select } from '@/components/ui'
import {
  SettingsPaneHeader,
  SettingsSection,
  SettingsRow,
  SettingsActionBar,
} from '@/features/settings/primitives'
import {
  getProxyState,
  restartBackend,
  saveProxyState,
  testProxy,
} from '@/services/desktopProxy'
import {
  createDefaultDesktopProxyState,
  type DesktopProxySavePayload,
  type DesktopProxyScheme,
  type DesktopProxyState,
  type DesktopProxyTestResult,
} from '@/types/desktopProxy'
import { notify } from '@/lib/notify/notify'
import { cn } from '@/lib/utils'

type FormState = DesktopProxyState & {
  /**
   * Local-only field. Three-way: undefined = leave stored password untouched,
   * '' = clear the stored password, non-empty = replace it. This mirrors the
   * IPC payload semantics so the form doesn't have to translate.
   */
  passwordDraft: string | undefined
}

function toFormState(state: DesktopProxyState): FormState {
  return { ...state, passwordDraft: undefined }
}

function statesEqual(a: FormState, b: FormState): boolean {
  return (
    a.enabled === b.enabled &&
    a.scheme === b.scheme &&
    a.host === b.host &&
    a.port === b.port &&
    a.username === b.username &&
    a.noProxy === b.noProxy &&
    a.passwordDraft === b.passwordDraft
  )
}

const schemeOrder: DesktopProxyScheme[] = ['http', 'https', 'socks5', 'socks5h']

type FeedbackTone = 'success' | 'error' | 'info'

type Feedback = { tone: FeedbackTone; message: string } | null

/**
 * Network → Proxy settings panel.
 *
 * Owns one piece of validated form state. The save flow is two-phase:
 *   1. POST the new config to the main process. The handler returns
 *      `requiresRestart` so we know whether the Go API needs a restart.
 *   2. If yes, prompt the user via a confirm dialog. Only on explicit
 *      confirmation do we call `restartBackend` — silent restart-on-save is
 *      a privacy hazard for users mid-workflow.
 */
export function NetworkSettings() {
  const { t } = useTranslation('settings')

  const [initial, setInitial] = useState<FormState>(() => toFormState(createDefaultDesktopProxyState()))
  const [form, setForm] = useState<FormState>(() => toFormState(createDefaultDesktopProxyState()))
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [feedback, setFeedback] = useState<Feedback>(null)
  const [restartDialog, setRestartDialog] = useState<null | { payload: DesktopProxySavePayload }>(null)
  const [restarting, setRestarting] = useState(false)
  const mountedRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const state = await getProxyState()
        if (cancelled) return
        const fresh = toFormState(state)
        setInitial(fresh)
        setForm(fresh)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const dirty = useMemo(() => !statesEqual(initial, form), [initial, form])

  const errors = useMemo(() => {
    const errs: Record<string, string> = {}
    if (form.enabled) {
      if (!form.host.trim()) {
        errs.host = t('network.proxy.errors.hostRequired')
      }
      if (!Number.isFinite(form.port) || form.port < 1 || form.port > 65535) {
        errs.port = t('network.proxy.errors.portRange')
      }
      if (!schemeOrder.includes(form.scheme)) {
        errs.scheme = t('network.proxy.errors.schemeRequired')
      }
    }
    return errs
  }, [form, t])

  const hasErrors = Object.keys(errors).length > 0

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
    if (feedback) setFeedback(null)
  }

  function buildPayload(state: FormState): DesktopProxySavePayload {
    const payload: DesktopProxySavePayload = {
      enabled: state.enabled,
      scheme: state.scheme,
      host: state.host.trim(),
      port: state.port,
      username: state.username.trim(),
      noProxy: state.noProxy,
    }
    if (state.passwordDraft !== undefined) {
      payload.password = state.passwordDraft
    }
    return payload
  }

  async function handleTest() {
    if (hasErrors) return
    setTesting(true)
    setFeedback(null)
    const toastId = notify.loading(t('network.proxy.testRunning'), { id: 'desktop-proxy-test' })
    try {
      const result: DesktopProxyTestResult = await testProxy(buildPayload(form))
      if (result.ok) {
        notify.success(t('network.proxy.testSuccess', { ms: result.latencyMs ?? 0 }), { id: toastId })
      } else {
        notify.error(t('network.proxy.testFailure', { message: result.message || '' }), { id: toastId })
      }
    } catch (error) {
      notify.error(
        t('network.proxy.testFailure', { message: (error as Error)?.message || String(error) }),
        { id: toastId },
      )
    } finally {
      if (mountedRef.current) setTesting(false)
    }
  }

  async function handleSave() {
    if (hasErrors || saving) return
    setSaving(true)
    setFeedback(null)
    try {
      const payload = buildPayload(form)
      const { state, requiresRestart } = await saveProxyState(payload)
      if (!mountedRef.current) return
      const fresh = toFormState(state)
      setInitial(fresh)
      setForm(fresh)
      if (requiresRestart) {
        setRestartDialog({ payload })
      } else {
        setFeedback({ tone: 'success', message: t('network.proxy.savedFeedback') })
      }
    } catch (error) {
      if (mountedRef.current) {
        setFeedback({ tone: 'error', message: (error as Error)?.message || String(error) })
      }
    } finally {
      if (mountedRef.current) setSaving(false)
    }
  }

  function handleCancel() {
    setForm(initial)
    setFeedback(null)
  }

  async function handleConfirmRestart() {
    setRestarting(true)
    try {
      const result = await restartBackend()
      if (!mountedRef.current) return
      if (result.ok) {
        setFeedback({ tone: 'success', message: t('network.proxy.restart.restarted') })
      } else {
        setFeedback({
          tone: 'error',
          message: t('network.proxy.restart.restartFailed', { message: result.message || '' }),
        })
      }
    } catch (error) {
      if (mountedRef.current) {
        setFeedback({
          tone: 'error',
          message: t('network.proxy.restart.restartFailed', {
            message: (error as Error)?.message || String(error),
          }),
        })
      }
    } finally {
      if (mountedRef.current) {
        setRestarting(false)
        setRestartDialog(null)
      }
    }
  }

  function handleCancelRestart() {
    setRestartDialog(null)
    setFeedback({
      tone: 'info',
      message: t('network.proxy.savedFeedback'),
    })
  }

  if (loading) {
    return (
      <>
        <SettingsPaneHeader title={t('sections.network.title')} description={t('network.description')} />
        <SettingsSection>
          <p className="text-sm text-muted-foreground">…</p>
        </SettingsSection>
      </>
    )
  }

  return (
    <>
      <SettingsPaneHeader title={t('sections.network.title')} description={t('network.description')} />

      <SettingsSection
        title={t('network.proxy.sectionTitle')}
        description={t('network.proxy.sectionDescription')}
      >
        <SettingsRow
          title={t('network.proxy.enableTitle')}
          description={t('network.proxy.enableDescription')}
        >
          <span className={cn('el-switch', form.enabled && 'is-checked')}>
            <button
              type="button"
              role="switch"
              aria-checked={form.enabled}
              className="settings-switch-button"
              aria-label={t('network.proxy.enableTitle')}
              onClick={() => update('enabled', !form.enabled)}
            >
              {form.enabled ? t('network.proxy.enabled') : t('network.proxy.disabled')}
            </button>
          </span>
        </SettingsRow>
      </SettingsSection>

      <fieldset
        disabled={!form.enabled}
        className={cn('contents', !form.enabled && 'opacity-60')}
      >
        <SettingsSection>
          <SettingsRow title={t('network.proxy.schemeLabel')}>
            <Select
              value={form.scheme}
              onChange={(event) => update('scheme', event.target.value as DesktopProxyScheme)}
              aria-label={t('network.proxy.schemeLabel')}
              className="settings-select w-full max-w-[256px]"
            >
              {schemeOrder.map((scheme) => (
                <option key={scheme} value={scheme}>
                  {t(`network.proxy.schemeOptions.${scheme}`)}
                </option>
              ))}
            </Select>
          </SettingsRow>

          <SettingsRow title={t('network.proxy.hostLabel')} description={errors.host}>
            <Input
              type="text"
              value={form.host}
              onChange={(event) => update('host', event.target.value)}
              placeholder={t('network.proxy.hostPlaceholder')}
              aria-invalid={Boolean(errors.host) || undefined}
              className="settings-input w-full max-w-[288px]"
            />
          </SettingsRow>

          <SettingsRow title={t('network.proxy.portLabel')} description={errors.port}>
            <Input
              type="number"
              min={1}
              max={65535}
              value={form.port > 0 ? String(form.port) : ''}
              onChange={(event) => {
                const next = Number.parseInt(event.target.value, 10)
                update('port', Number.isFinite(next) ? next : 0)
              }}
              placeholder={t('network.proxy.portPlaceholder')}
              aria-invalid={Boolean(errors.port) || undefined}
              className="settings-input w-full max-w-[128px]"
            />
          </SettingsRow>
        </SettingsSection>

        <SettingsSection title={t('network.proxy.usernameLabel').replace(/ \(.*\)$/, '')}>
          <SettingsRow title={t('network.proxy.usernameLabel')}>
            <Input
              type="text"
              value={form.username}
              autoComplete="off"
              onChange={(event) => update('username', event.target.value)}
              placeholder={t('network.proxy.usernamePlaceholder')}
              className="settings-input w-full max-w-[256px]"
            />
          </SettingsRow>

          <SettingsRow
            title={t('network.proxy.passwordLabel')}
            description={t('network.proxy.passwordHelp')}
          >
            <div className="flex w-full max-w-[288px] flex-col items-stretch gap-2">
              <PasswordInput
                value={form.passwordDraft ?? ''}
                autoComplete="off"
                onChange={(event) => update('passwordDraft', event.target.value)}
                className="settings-input"
                placeholder={
                  form.hasPassword && form.passwordDraft === undefined
                    ? '••••••••'
                    : t('network.proxy.passwordPlaceholder')
                }
              />
              {form.hasPassword && form.passwordDraft === undefined ? (
                <button
                  type="button"
                  className="text-left text-xs text-muted-foreground underline-offset-2 hover:underline"
                  onClick={() => update('passwordDraft', '')}
                  aria-label={t('network.proxy.passwordClearAction')}
                >
                  ✕ {t('network.proxy.passwordClearAction')}
                </button>
              ) : null}
            </div>
          </SettingsRow>
        </SettingsSection>

        <SettingsSection>
          <SettingsRow
            title={t('network.proxy.noProxyLabel')}
            description={t('network.proxy.noProxyHint')}
          >
            <Input
              type="text"
              value={form.noProxy}
              onChange={(event) => update('noProxy', event.target.value)}
              placeholder={t('network.proxy.noProxyPlaceholder')}
              className="settings-input w-full max-w-[384px]"
            />
          </SettingsRow>
        </SettingsSection>
      </fieldset>

      <SettingsSection>
        <SettingsRow
          title={t('network.proxy.testButton')}
          description={t('network.proxy.scopeNote')}
        >
          <Button
            variant="outline"
            onClick={() => void handleTest()}
            disabled={testing || hasErrors || !form.enabled}
          >
            <Network className="mr-2 size-4" aria-hidden="true" />
            {testing ? t('network.proxy.testRunning') : t('network.proxy.testButton')}
          </Button>
        </SettingsRow>
      </SettingsSection>

      {feedback ? (
        <div
          role={feedback.tone === 'error' ? 'alert' : 'status'}
          className={cn(
            'mx-6 mb-2 flex items-start gap-2 rounded-md border px-3 py-2 text-sm',
            feedback.tone === 'success' && 'border-emerald-300/40 bg-emerald-50 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100',
            feedback.tone === 'error' && 'border-red-300/40 bg-red-50 text-red-900 dark:bg-red-950/40 dark:text-red-100',
            feedback.tone === 'info' && 'border-slate-300/40 bg-slate-50 text-slate-800 dark:bg-slate-900/40 dark:text-slate-100',
          )}
        >
          {feedback.tone === 'error' ? (
            <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          ) : (
            <Globe className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          )}
          <span>{feedback.message}</span>
        </div>
      ) : null}

      <SettingsActionBar
        dirty={dirty && !hasErrors}
        onSave={() => void handleSave()}
        onCancel={handleCancel}
        saveLabel={t('network.proxy.saveButton')}
        saving={saving}
      />

      {restartDialog ? (
        <RestartConfirmDialog
          busy={restarting}
          onConfirm={() => void handleConfirmRestart()}
          onCancel={handleCancelRestart}
        />
      ) : null}
    </>
  )
}

type RestartDialogProps = {
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}

function RestartConfirmDialog({ busy, onConfirm, onCancel }: RestartDialogProps) {
  const { t } = useTranslation('settings')
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="proxy-restart-title"
      onClick={() => {
        if (!busy) onCancel()
      }}
    >
      <div
        className="w-full max-w-md rounded-lg border bg-background p-5 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="proxy-restart-title" className="text-base font-semibold">
          {t('network.proxy.restart.title')}
        </h3>
        <p className="mt-2 text-sm text-muted-foreground">
          {busy ? t('network.proxy.restart.restarting') : t('network.proxy.restart.body')}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            {t('network.proxy.restart.cancelButton')}
          </Button>
          <Button onClick={onConfirm} disabled={busy}>
            {busy ? t('network.proxy.restart.restarting') : t('network.proxy.restart.confirmButton')}
          </Button>
        </div>
      </div>
    </div>
  )
}
