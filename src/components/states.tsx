/**
 * The three shared states every data-backed pane renders: a Skeleton while
 * loading, an EmptyState when there is nothing yet, and an InlineError with
 * an optional retry when a request failed. Geometry and palette follow
 * docs/design.md: 12px cards, 8px buttons, restrained borders.
 */
import type { HTMLAttributes, ReactNode } from 'react'

import { Button } from '@/components/ui'
import { cn } from '@/lib/utils'

/** A neutral placeholder block; size it with width and height classes. */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden="true" className={cn('animate-pulse rounded-md bg-muted motion-reduce:animate-none', className)} {...props} />
}

/** A few skeleton rows for a list that is still loading. */
export function SkeletonRows({ rows = 3, className, label }: { rows?: number; className?: string; label: string }) {
  return (
    <div className={cn('space-y-2', className)} role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className={cn('h-3', index % 3 === 0 ? 'w-11/12' : index % 3 === 1 ? 'w-4/5' : 'w-2/3')} />
      ))}
    </div>
  )
}

export type EmptyStateProps = {
  icon?: ReactNode
  title: string
  description?: string
  /** Usually one primary Button. */
  action?: ReactNode
  className?: string
  'data-testid'?: string
}

export function EmptyState({ icon, title, description, action, className, ...rest }: EmptyStateProps) {
  return (
    <div className={cn('flex h-full items-center justify-center px-8 py-10 text-center', className)} data-testid={rest['data-testid']}>
      <div className="max-w-md">
        {icon ? <div className="mx-auto mb-4 flex justify-center text-primary [&>svg]:size-8">{icon}</div> : null}
        <h2 className="text-lg font-semibold text-foreground">{title}</h2>
        {description ? <p className="mt-2 text-sm text-muted-foreground">{description}</p> : null}
        {action ? <div className="mt-5 flex justify-center gap-2">{action}</div> : null}
      </div>
    </div>
  )
}

const inlineErrorSizes = {
  xs: 'rounded-md px-2.5 py-1.5 text-[11px]',
  sm: 'rounded-lg px-3 py-2 text-xs',
  md: 'rounded-lg px-3 py-2 text-sm',
} as const

export type InlineErrorProps = {
  /** The message; pass children instead for rich content. */
  message?: ReactNode
  children?: ReactNode
  size?: keyof typeof inlineErrorSizes
  onRetry?: () => void
  retryLabel?: string
  className?: string
  'data-testid'?: string
}

/** A request or validation failure shown in place, with an optional retry. */
export function InlineError({ message, children, size = 'md', onRetry, retryLabel = 'Retry', className, ...rest }: InlineErrorProps) {
  return (
    <div
      role="alert"
      className={cn('border border-destructive/30 bg-destructive/10 text-destructive', inlineErrorSizes[size], onRetry && 'flex items-center gap-3', className)}
      data-testid={rest['data-testid']}
    >
      <div className="min-w-0 flex-1">{children ?? message}</div>
      {onRetry ? (
        <Button type="button" variant="outline" size="sm" className="shrink-0 border-destructive/30 text-destructive hover:bg-destructive/15" onClick={onRetry}>
          {retryLabel}
        </Button>
      ) : null}
    </div>
  )
}
