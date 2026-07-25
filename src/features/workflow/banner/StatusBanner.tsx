import type { ReactNode } from 'react'
import { CheckCircle2, FileWarning, TriangleAlert, ZapOff } from 'lucide-react'

import type { NodeStatus } from '@/features/workflow/canvas/NodeCard'

export type StatusBannerKind = 'failing' | 'configured_disabled' | 'not_configured' | 'enabled'

export interface StatusBannerAction {
  label: string
  onClick: () => void
  /** Test hook for the CTA button; falls back to "status-banner-cta". */
  testId?: string
}

/**
 * StatusBanner renders the four-state header that lives between the doc's
 * sub-tabs and the canvas. The "enabled" state is intentionally NOT a
 * banner — it returns null so vertical space goes back to the workflow.
 *
 * Per the refactor plan:
 *   - failing            → red, surfaces the failing node summary + Fix CTA
 *   - configured_disabled → green, prompts the user to flip the toggle
 *   - not_configured     → grey, prompts finish-configuration
 *   - enabled            → no banner
 */
export interface StatusBannerProps {
  kind: StatusBannerKind
  /** Free-form lead text shown bold in front of the body copy.
   *  Example: "Last run failed —". Omit for not_configured/disabled cases. */
  leading?: string
  body: ReactNode
  primaryAction?: StatusBannerAction
}

const palette: Record<Exclude<StatusBannerKind, 'enabled'>, { wrap: string; cta: string; icon: ReactNode; iconTone: string }> = {
  failing: {
    wrap: 'border-destructive/30 bg-destructive/10 text-destructive',
    cta: 'border-destructive/30 bg-card text-destructive hover:bg-destructive/15',
    icon: <TriangleAlert className="size-4" />,
    iconTone: 'text-destructive',
  },
  configured_disabled: {
    wrap: 'border-success/30 bg-success/10 text-success-foreground',
    cta: 'border-success/30 bg-card text-success-foreground hover:bg-success/15',
    icon: <ZapOff className="size-4" />,
    iconTone: 'text-success-foreground',
  },
  not_configured: {
    wrap: 'border-border bg-muted/40 text-muted-foreground',
    cta: 'border-border bg-card text-foreground hover:bg-muted',
    icon: <FileWarning className="size-4" />,
    iconTone: 'text-muted-foreground',
  },
}

const enabledPlaceholder = (
  <div data-testid="workflow-status-banner" data-banner-state="enabled" className="sr-only">
    Enabled — no banner shown.
  </div>
)

export function StatusBanner({ kind, leading, body, primaryAction }: StatusBannerProps) {
  if (kind === 'enabled') return enabledPlaceholder
  const tones = palette[kind]
  return (
    <div
      data-testid="workflow-status-banner"
      data-banner-state={kind}
      className={`flex items-center gap-3 rounded-xl border px-3.5 py-2.5 text-sm ${tones.wrap}`}
    >
      <span className={tones.iconTone}>{tones.icon}</span>
      <span className="flex-1">
        {leading ? <b>{leading} </b> : null}
        {body}
      </span>
      {primaryAction ? (
        <button
          type="button"
          data-testid={primaryAction.testId || 'workflow-status-banner-cta'}
          onClick={primaryAction.onClick}
          className={`rounded-md border px-2.5 py-1 text-xs font-semibold ${tones.cta}`}
        >
          {primaryAction.label}
        </button>
      ) : null}
    </div>
  )
}

/**
 * deriveBannerState centralises the four-state logic so WorkflowHomePage
 * and the future DocTab both reach the same conclusion from the same
 * inputs. Keeping it pure also makes it trivial to unit-test.
 */
export interface BannerInputs {
  enabled: boolean
  /** Critical issues (severity-equivalent) from POST /validate. */
  issues: { nodeId: string; code: string; message: string }[]
  lastRunStatus?: 'ok' | 'error' | null
  lastRunMessage?: string | null
  /** When the action is currently failing, the nodeId helps the CTA jump
   *  back to the right place on the canvas. */
  failingNodeId?: string | null
}

export interface BannerState {
  kind: StatusBannerKind
  leading?: string
  body: string
  /** When kind === 'failing', the node id the Fix CTA should focus. */
  focusNodeId?: string | null
}

export function deriveBannerState(inputs: BannerInputs, t?: (key: string, opts?: Record<string, unknown>) => string): BannerState {
  const tx = t || ((_k: string, opts?: Record<string, unknown>) => (opts?.fallback as string) || _k)
  // connection_missing is a soft warning while the workflow is still
  // disabled — the user is presumably mid-configuration. Once enabled, it
  // becomes a real blocker because the run will fail.
  const blocking = inputs.issues.filter((issue) => issue.code !== 'connection_missing' || inputs.enabled)
  if (inputs.lastRunStatus === 'error') {
    return {
      kind: 'failing',
      // Failing surfaces the specific error verbatim — runtime failures
      // can be opaque without it (e.g. "SMTP server refused TLS"), and
      // the user often can't reproduce them locally to read the same
      // detail anywhere else.
      leading: tx('panels.home.statusBanner.lastRunFailedLeading', { fallback: 'Last run failed —' }),
      body: inputs.lastRunMessage || tx('panels.home.statusBanner.lastRunFailedFallback', { fallback: 'fix the action to re-enable.' }),
      focusNodeId: inputs.failingNodeId || (blocking[0]?.nodeId ?? null),
    }
  }
  if (blocking.length > 0) {
    if (inputs.enabled) {
      // Enabled-but-failing-validation is rare (someone toggled on, then
      // mutated to an invalid shape). Keep the specific message because
      // the canvas card may not have a chance to render before the
      // workflow is force-disabled by the server.
      return {
        kind: 'failing',
        leading: tx('panels.home.statusBanner.validationFailedLeading', { fallback: 'Validation failed —' }),
        body: blocking[0].message,
        focusNodeId: blocking[0].nodeId,
      }
    }
    // Draft state: the specific field error is ALREADY shown on the
    // canvas action card (actionInlineError) and in the drawer field
    // (DrawerField.error). Repeating it in the banner created a
    // three-places-say-the-same-thing pattern. Show a count summary
    // instead so the banner adds information rather than echoing it.
    const count = blocking.length
    return {
      kind: 'not_configured',
      body: count === 1
        ? tx('panels.home.statusBanner.notConfiguredOne', { fallback: 'Finish configuration before enabling this workflow.' })
        : tx('panels.home.statusBanner.notConfiguredOther', { count, fallback: `${count} fields need attention before this workflow can be enabled.` }),
      focusNodeId: blocking[0].nodeId,
    }
  }
  if (!inputs.enabled) {
    return {
      kind: 'configured_disabled',
      body: tx('panels.home.statusBanner.configuredDisabled', { fallback: 'Configuration looks good. Enable this workflow to start running it.' }),
    }
  }
  return { kind: 'enabled', body: '' }
}
