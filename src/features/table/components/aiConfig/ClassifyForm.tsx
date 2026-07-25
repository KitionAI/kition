import { useTranslation } from 'react-i18next'
import type { DataField } from '@/types/dataDocument'
import type { TextAIConfig } from '@/types/aiConfig'
import { SourceFieldPicker } from './sourceFieldPicker'

type ClassifyConfig = Extract<TextAIConfig, { type: 'classify' }>

export function ClassifyForm({
  fields,
  currentFieldId,
  value,
  onChange,
}: {
  fields: DataField[]
  currentFieldId: number
  value: ClassifyConfig
  onChange: (next: ClassifyConfig) => void
}) {
  const { t } = useTranslation('table')
  const text = value.categories.join('\n')
  return (
    <div className="data-inline-ai-config-form">
      <label>
        <span>{t('aiConfig.sourceField')}</span>
        <SourceFieldPicker
          fields={fields}
          currentFieldId={currentFieldId}
          value={value.source_field_id}
          onChange={(id) => onChange({ ...value, source_field_id: id })}
        />
      </label>
      <label>
        <span>{t('aiConfig.categoriesLabel')}</span>
        <textarea
          aria-label={t('aiConfig.categories')}
          rows={5}
          value={text}
          onChange={(event) =>
            onChange({
              ...value,
              categories: event.target.value
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean),
            })
          }
        />
      </label>
      <label className="data-inline-ai-config-checkbox">
        <input
          type="checkbox"
          checked={value.auto_update}
          onChange={(event) => onChange({ ...value, auto_update: event.target.checked })}
        />
        <span>{t('aiConfig.autoRegenerateSource')}</span>
      </label>
    </div>
  )
}
