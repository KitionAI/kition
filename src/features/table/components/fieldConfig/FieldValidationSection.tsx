import { useTranslation } from 'react-i18next'
import { Switch } from '@/registry/ui/switch'

export function FieldValidationSection({
  readonly,
  readonlyLocked,
  onReadonlyChange,
}: {
  readonly: boolean
  /** True when the field type forces readonly (e.g. formula). */
  readonlyLocked: boolean
  onReadonlyChange: (next: boolean) => void
}) {
  const { t } = useTranslation('table')
  return (
    <div className="flex flex-col gap-3">
      <span className="text-sm font-medium">{t('fieldConfig.validationRules')}</span>
      <label className="flex items-center gap-2 text-sm">
        <Switch
          data-testid="field-readonly-switch"
          checked={readonly || readonlyLocked}
          disabled={readonlyLocked}
          onCheckedChange={onReadonlyChange}
        />
        {t('fieldConfig.readonly')}
      </label>
    </div>
  )
}
