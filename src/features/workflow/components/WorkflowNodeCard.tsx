import { useTranslation } from 'react-i18next'

export interface WorkflowNodeCardProps {
  role: 'trigger' | 'action'
  title: string
  subtitle: string
  status: 'ok' | 'warn' | 'error'
  onClick?: () => void
  selected?: boolean
}

const ROLE_COLOR: Record<WorkflowNodeCardProps['role'], { chipClass: string; labelKey: string }> = {
  trigger: { chipClass: 'bg-primary/15 text-primary', labelKey: 'panels.home.nodeCard.drawerKindTrigger' },
  action: { chipClass: 'bg-warning/15 text-warning-foreground', labelKey: 'panels.home.nodeCard.drawerKindAction' },
}

const STATUS_ICON: Record<WorkflowNodeCardProps['status'], { char: string; className: string }> = {
  ok: { char: '✓', className: 'text-success' },
  warn: { char: '⚠', className: 'text-warning' },
  error: { char: '✕', className: 'text-destructive' },
}

export function WorkflowNodeCard({ role, title, subtitle, status, onClick, selected }: WorkflowNodeCardProps) {
  const { t } = useTranslation('workflow')
  const c = ROLE_COLOR[role]
  const s = STATUS_ICON[status]
  return (
    <div
      data-testid="node-card"
      data-role={role}
      onClick={onClick}
      className={[
        'flex w-[360px] items-center gap-3 rounded-lg bg-card p-3 shadow-sm transition-colors',
        selected ? 'border-2 border-primary' : 'border border-border',
        onClick ? 'cursor-pointer hover:bg-muted/30' : 'cursor-default',
      ].join(' ')}
    >
      <div aria-hidden className={`grid size-10 shrink-0 place-items-center rounded-lg text-lg font-semibold ${c.chipClass}`}>
        {role === 'trigger' ? '⊕' : '✉'}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-foreground">{title}</div>
        <div className="line-clamp-2 text-xs text-muted-foreground">
          {subtitle}
        </div>
      </div>
      <span data-testid="node-role-chip" className={`rounded-md px-2 py-1 text-[11px] font-medium ${c.chipClass}`}>{t(c.labelKey)}</span>
      <span data-testid="node-status" className={`text-base ${s.className}`}>{s.char}</span>
    </div>
  )
}
