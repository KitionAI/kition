import { useTranslation } from 'react-i18next'
import type { DataField } from '@/types/dataDocument'
import type { AttachmentAIConfig, DataFieldAIImageUseCase } from '@/types/aiConfig'
import { useCaseSchema } from '@/types/aiConfig'
import { SourceFieldPicker } from './sourceFieldPicker'

type ImageGenerationConfig = Extract<AttachmentAIConfig, { type: 'image_generation' }>

const ASPECTS = ['1:1', '16:9', '9:16', '4:3', '3:4', '21:9', '2:3', '3:2'] as const
const RESOLUTIONS = ['1K', '2K', '4K'] as const
const QUALITIES = ['low', 'medium', 'high'] as const

const USE_CASES = useCaseSchema.options

export function ImageGenerationForm({
  fields,
  currentFieldId,
  value,
  onChange,
}: {
  fields: DataField[]
  currentFieldId: number
  value: ImageGenerationConfig
  onChange: (next: ImageGenerationConfig) => void
}) {
  const { t } = useTranslation('table')
  function patch(partial: Partial<ImageGenerationConfig>) {
    onChange({ ...value, ...partial })
  }

  return (
    <div className="data-inline-ai-config-form">
      <label>
        <span>{t('aiConfig.useCase')}</span>
        <select
          aria-label={t('aiConfig.useCase')}
          value={value.image_use_case ?? 'inline_illustration'}
          onChange={(event) => patch({ image_use_case: event.target.value as DataFieldAIImageUseCase })}
        >
          {USE_CASES.map((option) => (
            <option key={option} value={option}>{t(`aiConfig.useCases.${option}`)}</option>
          ))}
        </select>
      </label>
      <label>
        <span>{t('aiConfig.sourceField')}</span>
        <SourceFieldPicker
          fields={fields}
          currentFieldId={currentFieldId}
          value={value.source_field_id}
          onChange={(id) => patch({ source_field_id: id })}
        />
      </label>
      <label>
        <span>{t('aiConfig.aspectRatio')}</span>
        <select
          aria-label={t('aiConfig.aspectRatio')}
          value={value.aspect_ratio}
          onChange={(event) => patch({ aspect_ratio: event.target.value as (typeof ASPECTS)[number] })}
        >
          {ASPECTS.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      </label>
      <label>
        <span>{t('aiConfig.resolution')}</span>
        <select
          aria-label={t('aiConfig.resolution')}
          value={value.resolution}
          onChange={(event) => patch({ resolution: event.target.value as (typeof RESOLUTIONS)[number] })}
        >
          {RESOLUTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      </label>
      <label>
        <span>{t('aiConfig.quality')}</span>
        <select
          aria-label={t('aiConfig.quality')}
          value={value.quality}
          onChange={(event) => patch({ quality: event.target.value as (typeof QUALITIES)[number] })}
        >
          {QUALITIES.map((option) => <option key={option} value={option}>{t(`aiConfig.qualities.${option}`)}</option>)}
        </select>
      </label>
      <label>
        <span>{t('aiConfig.variants')}</span>
        <input
          aria-label={t('aiConfig.variants')}
          type="number"
          min={1}
          max={10}
          value={value.n}
          onChange={(event) => patch({ n: Math.max(1, Math.min(10, Number(event.target.value) || 1)) })}
        />
      </label>
      <label className="data-inline-ai-config-checkbox">
        <input
          type="checkbox"
          checked={value.auto_update}
          onChange={(event) => patch({ auto_update: event.target.checked })}
        />
        <span>{t('aiConfig.autoRegenerateSourceField')}</span>
      </label>
    </div>
  )
}
