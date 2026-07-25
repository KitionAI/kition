import { useTranslation } from 'react-i18next'
import type { DataField } from '@/types/dataDocument'
import type { TextAIConfig } from '@/types/aiConfig'
import { SourceFieldPicker } from './sourceFieldPicker'

type SummarizeConfig = Extract<TextAIConfig, { type: 'summarize' }>

export function SummarizeForm({
  fields,
  currentFieldId,
  value,
  onChange,
}: {
  fields: DataField[]
  currentFieldId: number
  value: SummarizeConfig
  onChange: (next: SummarizeConfig) => void
}) {
  const { t } = useTranslation('table')
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
        <span>{t('aiConfig.maxWords')}</span>
        <input
          aria-label={t('aiConfig.maxWords')}
          type="number"
          min={10}
          value={value.max_words ?? ''}
          onChange={(event) => {
            const next = Number(event.target.value)
            onChange({ ...value, max_words: Number.isFinite(next) && next > 0 ? next : undefined })
          }}
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
