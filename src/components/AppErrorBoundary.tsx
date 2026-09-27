import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'

import { Button } from '@/components/ui'
import { useTranslation } from '@/i18n'

export type AppErrorBoundaryScope = 'app' | 'pane'

export interface AppErrorBoundaryProps {
  /**
   * `app` wraps the whole window and offers a reload. `pane` wraps one editor
   * surface so a crash in a document, table, or board leaves the shell usable.
   */
  scope: AppErrorBoundaryScope
  /** Human-readable name of the wrapped surface, shown in the fallback title. */
  label?: string
  /** When any value in this list changes, the boundary clears its error. */
  resetKeys?: readonly unknown[]
  onError?: (error: Error, info: ErrorInfo) => void
  children?: ReactNode
}

interface AppErrorBoundaryState {
  error: Error | null
}

function resetKeysChanged(previous: readonly unknown[] | undefined, next: readonly unknown[] | undefined) {
  if (previous === next) return false
  if (!previous || !next || previous.length !== next.length) return true
  return previous.some((value, index) => !Object.is(value, next[index]))
}

function toError(value: unknown): Error {
  if (value instanceof Error) return value
  return new Error(typeof value === 'string' ? value : String(value))
}

/**
 * Catches render errors below it and renders a recoverable fallback instead of
 * letting React unmount the whole tree. There is one of these around the app
 * root and one around every editor pane.
 */
export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return { error: toError(error) }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[kition] ${this.props.scope} boundary caught a render error`, error, info.componentStack)
    this.props.onError?.(error, info)
  }

  componentDidUpdate(previousProps: AppErrorBoundaryProps) {
    if (this.state.error && resetKeysChanged(previousProps.resetKeys, this.props.resetKeys)) {
      this.reset()
    }
  }

  reset = () => {
    this.setState({ error: null })
  }

  render() {
    if (!this.state.error) {
      return this.props.children
    }
    return (
      <AppErrorFallback
        scope={this.props.scope}
        label={this.props.label}
        error={this.state.error}
        onRetry={this.reset}
      />
    )
  }
}

interface AppErrorFallbackProps {
  scope: AppErrorBoundaryScope
  label?: string
  error: Error
  onRetry: () => void
}

function AppErrorFallback({ scope, label, error, onRetry }: AppErrorFallbackProps) {
  const { t } = useTranslation('common')
  const title = scope === 'app'
    ? t('errorBoundary.title')
    : label
      ? t('errorBoundary.paneTitle', { label })
      : t('errorBoundary.paneTitleGeneric')

  return (
    <div
      className="flex h-full min-h-[240px] w-full items-center justify-center bg-background p-6"
      role="alert"
      data-testid="app-error-boundary"
      data-scope={scope}
    >
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-sm">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-destructive/10 text-destructive" aria-hidden="true">
            <AlertTriangle className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-foreground">{title}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t('errorBoundary.description')}</p>
          </div>
        </div>
        <details className="mt-4 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none font-medium text-foreground">{t('errorBoundary.details')}</summary>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono">{error.message}</pre>
        </details>
        <div className="mt-4 flex justify-end gap-2">
          {scope === 'app' ? (
            <Button
              variant="outline"
              data-testid="app-error-boundary-reload"
              onClick={() => window.location.reload()}
            >
              {t('errorBoundary.reload')}
            </Button>
          ) : null}
          <Button data-testid="app-error-boundary-retry" onClick={onRetry}>
            {t('errorBoundary.retry')}
          </Button>
        </div>
      </div>
    </div>
  )
}
