import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

type AgentPanelHeaderProps = {
  title: string
  subtitle: string
  actions?: ReactNode
  className?: string
  copyClassName?: string
  actionsClassName?: string
}

export function AgentPanelHeader({
  title,
  subtitle,
  actions,
  className,
  copyClassName,
  actionsClassName,
}: AgentPanelHeaderProps) {
  return (
    <div className={cn('agent-chat-header', className)}>
      <div className={copyClassName}>
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </div>
      {actions ? (
        <div className={cn('agent-chat-header-actions', actionsClassName)}>{actions}</div>
      ) : null}
    </div>
  )
}

type AgentPanelEmptyStateProps = {
  icon: ReactNode
  title: string
  description: string
  actions?: ReactNode
}

export function AgentPanelEmptyState({
  icon,
  title,
  description,
  actions,
}: AgentPanelEmptyStateProps) {
  return (
    <div className="agent-chat-empty">
      <span className="agent-chat-empty-icon">{icon}</span>
      <strong>{title}</strong>
      <p>{description}</p>
      {actions ? <div className="agent-chat-empty-actions">{actions}</div> : null}
    </div>
  )
}
