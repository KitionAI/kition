import { useTranslation } from 'react-i18next'

export type TriggerType =
  | 'record_created' | 'record_created_or_updated' | 'record_updated'
  | 'scheduled_time' | 'button_clicked'
  | 'record_date_reached'

const OPTIONS: { type: TriggerType; icon: string; labelKey: string; enabled: boolean }[] = [
  { type: 'record_created', icon: '⊕', labelKey: 'triggerPicker.recordCreated', enabled: true },
  { type: 'record_created_or_updated', icon: '▽', labelKey: 'triggerPicker.recordCreatedOrUpdated', enabled: true },
  { type: 'record_updated', icon: '⟲', labelKey: 'triggerPicker.recordUpdated', enabled: true },
  { type: 'record_date_reached', icon: '📅', labelKey: 'triggerPicker.recordTriggerTime', enabled: true },
  { type: 'scheduled_time', icon: '⏱', labelKey: 'triggerPicker.scheduledTime', enabled: true },
  { type: 'button_clicked', icon: '⛛', labelKey: 'triggerPicker.buttonClicked', enabled: false },
]

export interface TriggerPickerProps {
  onPick: (type: TriggerType) => void
}

export function TriggerPicker({ onPick }: TriggerPickerProps) {
  const { t } = useTranslation('workflow')
  return (
    <div
      data-testid="trigger-picker"
      className="w-80 rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-floating"
    >
      <div className="mb-2 text-xs text-muted-foreground">{t('triggerPicker.selectPrompt')}</div>
      <ul className="m-0 list-none p-0">
        {OPTIONS.map((o) => (
          <li
            key={o.type}
            data-testid={`trigger-option-${o.type}`}
            aria-disabled={o.enabled ? 'false' : 'true'}
            onClick={() => { if (o.enabled) onPick(o.type) }}
            className={[
              'flex items-center gap-3 rounded-md px-1 py-2 text-sm transition-colors',
              o.enabled ? 'cursor-pointer text-foreground hover:bg-muted/40' : 'cursor-not-allowed text-muted-foreground/60',
            ].join(' ')}
          >
            <span className="w-5 text-center">{o.icon}</span>
            <span>{t(o.labelKey)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
