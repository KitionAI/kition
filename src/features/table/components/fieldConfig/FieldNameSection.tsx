import { useTranslation } from 'react-i18next'
import { Plus } from 'lucide-react'
import { Button, Input, Textarea } from '@/components/ui'

export function FieldNameSection({
  name,
  description,
  onNameChange,
  onDescriptionChange,
  onToggleAdvanced,
}: {
  name: string
  description: string
  onNameChange: (next: string) => void
  onDescriptionChange: (next: string) => void
  onToggleAdvanced: () => void
}) {
  const { t } = useTranslation('table')
  const showDescription = description.length > 0
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-medium">{t('fieldConfig.name')}</span>
        <button
          type="button"
          data-testid="field-advanced-toggle"
          onClick={onToggleAdvanced}
          className="text-xs text-muted-foreground underline-offset-2 hover:underline"
        >
          {t('fieldConfig.advancedProperties')}
        </button>
      </div>
      <Input
        value={name}
        onChange={(event) => onNameChange(event.target.value)}
        placeholder={t('fieldConfig.fieldNamePlaceholder')}
      />
      {showDescription ? (
        <Textarea
          data-testid="field-description"
          value={description}
          onChange={(event) => onDescriptionChange(event.target.value)}
          placeholder={t('fieldConfig.descriptionPlaceholder')}
          className="min-h-12 resize-y"
        />
      ) : (
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="field-description-add"
            onClick={() => onDescriptionChange(' ')}
            className="gap-1"
          >
            <Plus className="size-4" />
            {t('fieldConfig.addDescription')}
          </Button>
        </div>
      )}
    </div>
  )
}
