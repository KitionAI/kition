import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ModelCapability } from '../../../types/base'
import { useTableHost } from '../../ports/TableHost'

type ModelPickerProps = {
  value: string | undefined
  capability: ModelCapability
  onChange: (modelKey: string | undefined) => void
}

export function ModelPicker({ value, capability, onChange }: ModelPickerProps) {
  const { t } = useTranslation('table')
  const { ai } = useTableHost()
  const [options, setOptions] = useState<Array<{ value: string; label: string }>>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    if (!ai) {
      setLoading(false)
      return undefined
    }
    setLoading(true)
    setError(null)
    ai.loadModelOptions(capability)
      .then((items) => {
        if (cancelled) return
        setOptions(items)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : t('aiConfig.model.loadFailed'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [ai, capability, t])

  const knownValue = value && options.some((option) => option.value === value)

  return (
    <select
      aria-label={t('aiConfig.runtimeModelOverride')}
      className="data-inline-ai-model-picker"
      value={value ?? ''}
      onChange={(event) => onChange(event.target.value || undefined)}
      disabled={loading}
    >
      <option value="">
        {loading
          ? t('aiConfig.model.loading')
          : error
            ? t('aiConfig.model.defaultWithError', { error })
            : options.length
              ? t('aiConfig.model.default')
              : t('aiConfig.model.defaultNoDesktop')}
      </option>
      {value && !knownValue && !loading ? (
        <option value={value}>{t('aiConfig.model.unavailable', { model: value })}</option>
      ) : null}
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}
