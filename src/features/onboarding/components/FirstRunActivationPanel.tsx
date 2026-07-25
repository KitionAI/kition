import { useRef, useState } from 'react'
import { Cloud, FolderCheck, KeyRound, Laptop, LoaderCircle } from 'lucide-react'

import { Button } from '@/components/ui'
import { useKitionAccount } from '@/features/account/hooks/useKitionAccount'
import { isKitionAccountSessionUsable } from '@/features/account/lib/accountState'
import { useTranslation } from '@/i18n'

type FirstRunActivationPanelProps = {
  workspaceName: string
  onStartCloud: () => void
  onConfigureModels: () => void
  onStartLocal: () => void
  onSkip: () => void
}

export function FirstRunActivationPanel({
  workspaceName,
  onStartCloud,
  onConfigureModels,
  onStartLocal,
  onSkip,
}: FirstRunActivationPanelProps) {
  const { t } = useTranslation('workspaceLauncher')
  const kitionAccount = useKitionAccount()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const signInCancelledRef = useRef(false)

  async function handleCloudAction() {
    if (kitionAccount.state.status === 'connecting') {
      signInCancelledRef.current = true
      kitionAccount.cancelConnect()
      return
    }
    signInCancelledRef.current = false
    setBusy(true)
    setError('')
    try {
      const session = await kitionAccount.ensureReady()
      if (signInCancelledRef.current) {
        signInCancelledRef.current = false
        return
      }
      if (isKitionAccountSessionUsable(session)) {
        onStartCloud()
        return
      }
      if (session) {
        setError(t('firstRun.cloudCreditsEmpty'))
      } else if (kitionAccount.state.errorMessage) {
        setError(kitionAccount.state.errorMessage)
      } else {
        setError(t('firstRun.cloudUnavailable'))
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t('firstRun.cloudUnavailable'))
    } finally {
      setBusy(false)
    }
  }

  const cloudPending = busy || kitionAccount.state.status === 'connecting'

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-foreground/25 p-4 backdrop-blur-[2px]"
      data-testid="first-run-activation-stage"
    >
      <section
        className="flex max-h-[calc(100vh-32px)] w-full max-w-[720px] flex-col overflow-y-auto rounded-xl border border-border bg-background text-foreground shadow-floating"
        role="dialog"
        aria-modal="true"
        aria-label={t('firstRun.dialogLabel')}
        data-testid="first-run-activation"
      >
        <header className="border-b border-border px-6 py-5 sm:px-8">
          <p className="text-xs font-semibold uppercase tracking-wide text-primary">{t('firstRun.eyebrow')}</p>
          <h1 className="mt-1 text-xl font-semibold">{t('firstRun.workspaceTitle')}</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            {t('firstRun.workspaceDescription')}
          </p>
        </header>

        <div className="flex-1 px-6 py-6 sm:px-8" data-testid="first-run-step-workspace">
          <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/35 px-4 py-3">
            <FolderCheck className="size-5 shrink-0 text-success" />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{workspaceName}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{t('firstRun.workspaceLocal')}</p>
            </div>
          </div>

          <div className="mt-5 grid gap-3">
            <div className="flex flex-col gap-4 rounded-lg border border-border bg-background p-4 sm:flex-row sm:items-center">
              <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                <Cloud className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="text-sm font-semibold">{t('firstRun.choice.cloud')}</h2>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('firstRun.choice.cloudDescription')}</p>
              </div>
              <Button
                className="shrink-0 sm:min-w-44"
                onClick={() => void handleCloudAction()}
                disabled={kitionAccount.state.status === 'loading' || (busy && kitionAccount.state.status !== 'connecting')}
                data-testid="first-run-start-cloud"
              >
                {cloudPending ? <LoaderCircle className="size-4 animate-spin" /> : <Cloud className="size-4" />}
                {kitionAccount.state.status === 'connecting' ? t('firstRun.cancelSignIn') : t('firstRun.startCloud')}
              </Button>
            </div>

            <div className="flex flex-col gap-4 rounded-lg border border-border bg-background p-4 sm:flex-row sm:items-center">
              <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                <KeyRound className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="text-sm font-semibold">{t('firstRun.choice.byo')}</h2>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('firstRun.choice.byoDescription')}</p>
              </div>
              <Button
                variant="outline"
                className="shrink-0 sm:min-w-44"
                onClick={onConfigureModels}
                data-testid="first-run-configure-models"
              >
                <KeyRound className="size-4" />
                {t('firstRun.configureModels')}
              </Button>
            </div>

            <div className="flex flex-col gap-4 rounded-lg border border-border bg-background p-4 sm:flex-row sm:items-center">
              <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                <Laptop className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="text-sm font-semibold">{t('firstRun.choice.local')}</h2>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('firstRun.choice.localDescription')}</p>
              </div>
              <Button
                variant="outline"
                className="shrink-0 sm:min-w-44"
                onClick={onStartLocal}
                data-testid="first-run-start-local"
              >
                <Laptop className="size-4" />
                {t('firstRun.startLocal')}
              </Button>
            </div>
          </div>

          <p className="mt-4 text-xs leading-5 text-muted-foreground">{t('firstRun.providerDescription')}</p>
          {error ? (
            <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">
              {error}
            </div>
          ) : null}
        </div>

        <footer className="flex items-center justify-end border-t border-border px-6 py-4 sm:px-8">
          <Button variant="ghost" onClick={onSkip}>{t('firstRun.skip')}</Button>
        </footer>
      </section>
    </div>
  )
}
