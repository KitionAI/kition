import type { ReactNode } from 'react'

/**
 * Small presentational primitives split out of WorkflowHomePage (WF-C1b).
 *
 * Each component is a pure render — no state, no effects — so they read as
 * pure styling helpers. Keeping them here rather than inlined in the page
 * makes the WorkflowHomePage JSX easier to follow and lets us put the
 * styling decisions next to each other for visual review without scrolling
 * through 2k lines of state management.
 *
 * They're WorkflowHomePage-shaped specifically — the chip palette, the
 * step-card layout, the field error testid all encode page-level decisions
 * — so they live under pages/ rather than the shared components/ folder.
 * If a second page needs them, promote then.
 */

export function FilterChip({
  active,
  tone,
  onClick,
  children,
}: {
  active: boolean
  tone?: 'error'
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className={`rounded-lg border px-2.5 py-1 text-[11px] font-medium ${
        active
          ? tone === 'error' ? 'border-destructive/30 bg-destructive/10 text-destructive' : 'border-primary/30 bg-primary/15 text-primary'
          : tone === 'error' ? 'border-transparent bg-muted text-destructive' : 'border-transparent bg-muted text-muted-foreground'
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

export function FlowLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-1.5">
      <span className="w-9 shrink-0 text-[10px] font-semibold text-muted-foreground/80">{label}</span>
      <span className="min-w-0 truncate">{value}</span>
    </div>
  )
}

export function StatusPill({ status }: { status: 'on' | 'off' | 'error' | 'streaming' }) {
  const className = status === 'error'
    ? 'bg-destructive/15 text-destructive'
    : status === 'on'
      ? 'bg-success/15 text-success-foreground'
      : status === 'streaming'
        ? 'bg-primary/15 text-primary'
        : 'bg-muted text-muted-foreground'
  return <span className={`shrink-0 rounded-lg px-1.5 py-0.5 text-[10px] font-semibold ${className}`}>{status.toUpperCase()}</span>
}

export function StepCard({
  step,
  title,
  description,
  children,
}: {
  step: string
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <span className="inline-grid size-5 place-items-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary">{step}</span>
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="ml-auto text-xs text-muted-foreground/80">{description}</span>
      </header>
      <div className="grid gap-4 p-4">{children}</div>
    </section>
  )
}

export function Field({
  label,
  hint,
  action,
  error,
  children,
}: {
  label: string
  hint?: string
  action?: ReactNode
  error?: string
  children: ReactNode
}) {
  return (
    <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
      <span className="flex items-center justify-between gap-2">
        <span>{label} {hint ? <span className="font-normal text-muted-foreground/80">{hint}</span> : null}</span>
        {action}
      </span>
      {children}
      {error ? <span className="text-[11px] font-normal text-destructive" data-testid="workflow-home-field-error">{error}</span> : null}
    </label>
  )
}
