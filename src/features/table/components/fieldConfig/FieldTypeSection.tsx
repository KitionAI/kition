import { useTranslation } from 'react-i18next'
import { Select } from '@/components/ui'
import { fieldTypes } from '@/features/table/lib/tableEditorShared'
import type { DataFieldType } from '@/types/dataDocument'

const SUBTITLE_KEYS: Partial<Record<DataFieldType, string>> = {
  attachment: 'fieldTypeSubtitles.attachment',
  text: 'fieldTypeSubtitles.text',
  long_text: 'fieldTypeSubtitles.longText',
  number: 'fieldTypeSubtitles.number',
  single_select: 'fieldTypeSubtitles.singleSelect',
  multi_select: 'fieldTypeSubtitles.multiSelect',
  date: 'fieldTypeSubtitles.date',
  formula: 'fieldTypeSubtitles.formula',
}

export function FieldTypeSection({
  type,
  onChange,
}: {
  type: DataFieldType
  onChange: (next: DataFieldType) => void
}) {
  const { t } = useTranslation('table')
  const subtitleKey = SUBTITLE_KEYS[type]
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium">{t('fieldConfig.type')}</span>
      <Select value={type} onChange={(event) => onChange(event.target.value as DataFieldType)}>
        {fieldTypes.map((ft) => (
          <option key={ft.value} value={ft.value}>{t(ft.labelKey)}</option>
        ))}
      </Select>
      {subtitleKey ? (
        <p className="text-xs leading-relaxed text-muted-foreground">{t(subtitleKey)}</p>
      ) : null}
    </div>
  )
}
