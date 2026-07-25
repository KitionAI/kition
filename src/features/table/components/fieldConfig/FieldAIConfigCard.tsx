import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, Sparkles } from 'lucide-react'

import type { DataField } from '@/types/dataDocument'
import type { AnyAIConfig } from '@/types/aiConfig'
import { cn } from '@/lib/utils'
import { AIConfigPanel } from '../aiConfig/AIConfigPanel'

export function FieldAIConfigCard({
  field,
  fields,
  value,
  onChange,
}: {
  field: DataField
  fields: DataField[]
  value: AnyAIConfig | undefined
  onChange: (next: AnyAIConfig | undefined) => void
}) {
  const { t } = useTranslation('table')
  const hasConfig = Boolean(value?.enabled)
  const [expanded, setExpanded] = useState(hasConfig)

  useEffect(() => {
    setExpanded(Boolean(value?.enabled))
  }, [value?.enabled])

  return (
    <div className="w-full rounded-md border border-border text-sm">
      <button
        type="button"
        data-testid="field-ai-config-toggle"
        onClick={() => setExpanded((prev) => !prev)}
        className={cn(
          'group flex w-full cursor-pointer select-none items-center justify-between',
          'rounded-sm px-3 py-2 transition-all duration-500 ease-in-out',
          // Light mode uses the original pastel mint→sky→rose gradient.
          // Dark mode replaces it with a single brand-primary tint so the
          // button no longer glows like neon against the dark page.
          'bg-gradient-to-r from-teal-100 via-blue-50 to-rose-50',
          'hover:from-teal-100/70 hover:via-blue-50/70 hover:to-rose-50/70',
          'dark:bg-none dark:bg-primary/15 dark:text-foreground dark:hover:bg-primary/20',
          expanded && 'rounded-b-none',
        )}
      >
        <span className="flex items-center gap-x-1">
          <Sparkles className="size-4 text-amber-500 dark:text-primary" />
          {t('fieldConfig.aiConfig')}
        </span>
        <span className="flex items-center gap-x-3">
          {hasConfig ? (
            <span
              data-testid="field-ai-config-remove"
              role="button"
              tabIndex={0}
              onClick={(event) => {
                event.stopPropagation()
                onChange(undefined)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  event.stopPropagation()
                  onChange(undefined)
                }
              }}
              className="cursor-pointer truncate rounded-sm border-b border-muted-foreground/80 text-xs text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              {t('fieldConfig.removeConfig')}
            </span>
          ) : null}
          {expanded ? (
            <ChevronDown className="size-4 shrink-0" />
          ) : (
            <ChevronRight className="size-4 shrink-0" />
          )}
        </span>
      </button>
      {expanded ? (
        <div className="space-y-4 border-t border-border p-4">
          <AIConfigPanel
            chrome="embedded"
            field={field}
            fields={fields}
            value={value}
            onChange={onChange}
          />
        </div>
      ) : null}
    </div>
  )
}
