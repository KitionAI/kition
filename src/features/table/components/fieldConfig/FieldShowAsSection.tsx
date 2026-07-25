import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

export type LongTextShowAs = 'text' | 'markdown'

export function FieldShowAsSection({
  value,
  onChange,
}: {
  value: LongTextShowAs
  onChange: (next: LongTextShowAs) => void
}) {
  const { t } = useTranslation('table')
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium">{t('fieldConfig.showAs')}</span>
      <div
        role="tablist"
        aria-label={t('fieldConfig.showAs')}
        className="inline-flex w-full rounded-md border border-border bg-muted p-1"
      >
        <ShowAsOption value="text" current={value} onSelect={onChange}>
          {t('fieldConfig.showAsText')}
        </ShowAsOption>
        <ShowAsOption value="markdown" current={value} onSelect={onChange}>
          {t('fieldConfig.showAsMarkdown')}
        </ShowAsOption>
      </div>
    </div>
  )
}

function ShowAsOption({
  value,
  current,
  onSelect,
  children,
}: {
  value: LongTextShowAs
  current: LongTextShowAs
  onSelect: (next: LongTextShowAs) => void
  children: React.ReactNode
}) {
  const active = current === value
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-testid={`field-show-as-${value}`}
      onClick={() => onSelect(value)}
      className={cn(
        'flex-1 rounded-sm px-3 py-1.5 text-sm transition',
        active
          ? 'bg-background text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}
