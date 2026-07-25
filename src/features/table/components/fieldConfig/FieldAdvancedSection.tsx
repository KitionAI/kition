import { useTranslation } from 'react-i18next'
import { Select } from '@/components/ui'
import { cn } from '@/lib/utils'
import { fieldColorTones } from '@/features/table/lib/tableEditorShared'

const TONE_BG: Record<string, string> = {
  slate: 'hsl(var(--secondary))',
  amber: 'rgb(253, 230, 138)',
  sky: 'rgb(186, 230, 253)',
  violet: 'hsl(var(--tint-lavender))',
  emerald: 'rgb(167, 243, 208)',
  cyan: 'rgb(165, 243, 252)',
  blue: 'hsl(var(--tint-sky))',
  rose: 'rgb(254, 205, 211)',
}

export function FieldAdvancedSection({
  open,
  columnTone,
  fieldId,
  onColumnToneChange,
}: {
  open: boolean
  columnTone: string
  fieldId: number
  onColumnToneChange: (next: string) => void
}) {
  const { t } = useTranslation('table')
  if (!open) return null
  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-muted/30 p-3">
      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {t('fieldConfig.advancedProperties')}
      </span>
      <div className="flex flex-col gap-2 text-sm">
        <span className="text-sm font-medium">{t('fieldConfig.columnColor')}</span>
        <Select value={columnTone} onChange={(event) => onColumnToneChange(event.target.value)}>
          {fieldColorTones.map((tone) => (
            <option key={tone.value} value={tone.value}>{t(tone.labelKey)}</option>
          ))}
        </Select>
        <div className="mt-1 grid grid-cols-8 gap-2">
          {fieldColorTones.map((tone) => (
            <button
              key={tone.value}
              type="button"
              title={t(tone.labelKey)}
              onClick={() => onColumnToneChange(tone.value)}
              className={cn(
                'h-7 rounded-md border border-transparent ring-offset-2 transition',
                columnTone === tone.value && 'border-foreground ring-2 ring-ring/30',
              )}
              style={{ backgroundColor: TONE_BG[tone.value] ?? 'transparent' }}
            />
          ))}
        </div>
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{t('fieldConfig.fieldId')}</span>
        <code className="font-mono">{fieldId}</code>
      </div>
    </div>
  )
}
