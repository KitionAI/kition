export interface WorkflowStatusToggleProps {
  enabled: boolean
  saving?: boolean
  disabled?: boolean
  testId?: string
  onToggle: (enabled: boolean) => void
}

export function WorkflowStatusToggle({
  enabled,
  saving,
  disabled,
  testId = 'status-toggle',
  onToggle,
}: WorkflowStatusToggleProps) {
  const isLocked = disabled || saving
  return (
    <button
      data-testid={testId}
      type="button"
      aria-pressed={enabled}
      aria-label={enabled ? 'Disable workflow' : 'Enable workflow'}
      disabled={isLocked}
      onClick={() => onToggle(!enabled)}
      className={[
        'relative h-5 w-9 shrink-0 rounded-full transition-colors',
        enabled ? 'bg-primary' : 'bg-muted',
        isLocked ? (saving ? 'cursor-wait opacity-60' : 'cursor-not-allowed opacity-60') : 'cursor-pointer',
        disabled && !saving ? 'opacity-60' : '',
      ].join(' ')}
    >
      <span
        aria-hidden
        className={[
          'absolute left-0.5 top-0.5 size-4 rounded-full bg-card shadow-sm transition-transform',
          enabled ? 'translate-x-4' : 'translate-x-0',
        ].join(' ')}
      />
    </button>
  )
}
