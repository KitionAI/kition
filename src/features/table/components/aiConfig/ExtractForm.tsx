import { useTranslation } from 'react-i18next'
import type { DataField } from '@/types/dataDocument'
import type { TextAIConfig } from '@/types/aiConfig'
import { SourceFieldPicker } from './sourceFieldPicker'

type ExtractConfig = Extract<TextAIConfig, { type: 'extract' }>

export function ExtractForm({
  fields,
  currentFieldId,
  value,
  onChange,
}: {
  fields: DataField[]
  currentFieldId: number
  value: ExtractConfig
  onChange: (next: ExtractConfig) => void
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
        <span>{t('aiConfig.outputSchema')}</span>
        <textarea
          aria-label={t('aiConfig.schema')}
          rows={5}
          value={value.schema ?? ''}
          onChange={(event) => onChange({ ...value, schema: event.target.value || undefined })}
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
