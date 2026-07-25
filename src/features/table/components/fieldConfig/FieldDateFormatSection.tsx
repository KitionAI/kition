import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { Select } from '@/components/ui'
import {
  formatTableFieldValue,
  TABLE_DATE_FORMATS,
} from '@/features/table/lib/dateFormatting'
import type { DataDateFormat } from '@/types/dataDocument'

const SAMPLE_DATE = new Date(2026, 0, 30, 14, 0, 0).toISOString()

export function FieldDateFormatSection({
  value,
  onChange,
}: {
  value: DataDateFormat
  onChange: (next: DataDateFormat) => void
}) {
  const { t } = useTranslation('table')
  const options = useMemo(() => TABLE_DATE_FORMATS.map((format) => ({
    format,
    label: formatTableFieldValue({
      type: 'datetime',
      options: { date_format: format },
    }, SAMPLE_DATE),
  })), [])

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium">
        {t('fieldConfig.dateFormat', { defaultValue: 'Date format' })}
      </span>
      <Select
        value={value}
        data-testid="field-date-format"
        onChange={(event) => onChange(event.target.value as DataDateFormat)}
      >
        {options.map((option) => (
          <option key={option.format} value={option.format}>{option.label}</option>
        ))}
      </Select>
    </div>
  )
}
