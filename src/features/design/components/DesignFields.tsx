import { useEffect, useState } from 'react'
export function DesignNumberField({
  label,
  value,
  onChange,
  min = -100000,
  max = 16384,
  step = 1,
}: {
  label: string
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  step?: number
}) {
  const [draft, setDraft] = useState(String(Math.round(value * 100) / 100))
  useEffect(() => setDraft(String(Math.round(value * 100) / 100)), [value])
  const commit = () => {
    const number = Number(draft)
    if (draft.trim() && Number.isFinite(number))
      onChange(Math.max(min, Math.min(max, number)))
    else setDraft(String(value))
  }
  return (
    <label className="design-field">
      <span>{label}</span>
      <input
        type="number"
        aria-label={label}
        value={draft}
        min={min}
        max={max}
        step={step}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
        }}
      />
    </label>
  )
}
export function DesignColorField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <label className="design-field design-color">
      <span>{label}</span>
      <input
        type="color"
        aria-label={label}
        value={value === 'transparent' ? '#ffffff' : value.slice(0, 7)}
        onChange={(event) => onChange(event.target.value)}
      />
      <span>{value}</span>
    </label>
  )
}
