import { useTranslation } from 'react-i18next'
import type { DataField } from '@/types/dataDocument'

export function SourceFieldPicker({
  fields,
  currentFieldId,
  value,
  onChange,
}: {
  fields: DataField[]
  currentFieldId: number
  value: number | null | undefined
  onChange: (fieldId: number) => void
}) {
  const { t } = useTranslation('table')
  const candidates = fields.filter((field) => field.id !== currentFieldId)
  return (
    <select
      role="combobox"
      className="data-inline-ai-source-picker"
      value={value == null ? '' : String(value)}
      onChange={(event) => {
        const next = Number(event.target.value)
        if (Number.isFinite(next) && next > 0) onChange(next)
      }}
    >
      <option value="" disabled>{t('aiConfig.selectSourceField')}</option>
      {candidates.map((field) => (
        <option key={field.id} value={field.id}>{field.title || field.name}</option>
      ))}
    </select>
  )
}
