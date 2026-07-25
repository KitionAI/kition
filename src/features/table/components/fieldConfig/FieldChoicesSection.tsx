import { useTranslation } from 'react-i18next'
import { GripVertical } from 'lucide-react'
import { Input } from '@/components/ui'
import { cn } from '@/lib/utils'
import {
  getSelectTone,
  normalizeChoiceTone,
  selectPalette,
} from '@/features/table/lib/tableEditorShared'

export function FieldChoicesSection({
  choices,
  choiceTones,
  onChoicesChange,
  onChoiceTonesChange,
}: {
  choices: string[]
  choiceTones: Record<string, string>
  onChoicesChange: (next: string[]) => void
  onChoiceTonesChange: (next: Record<string, string>) => void
}) {
  const { t } = useTranslation('table')
  function updateChoice(index: number, nextChoice: string) {
    const previousChoice = choices[index]
    const nextChoices = choices.map((choice, i) => (i === index ? nextChoice : choice))
    onChoicesChange(nextChoices)
    if (previousChoice && previousChoice !== nextChoice) {
      const next = { ...choiceTones }
      if (next[previousChoice] && !next[nextChoice]) next[nextChoice] = next[previousChoice]
      delete next[previousChoice]
      onChoiceTonesChange(next)
    }
  }

  function updateChoiceTone(choice: string, tone: string) {
    onChoiceTonesChange({ ...choiceTones, [choice]: tone })
  }

  return (
    <div className="data-inline-choice-editor">
      <div className="data-inline-choice-editor-head">
        <span>{t('fieldChoices.options')}</span>
        <button
          type="button"
          onClick={() => onChoicesChange([...choices, t('fieldChoices.optionDefault', { index: choices.length + 1 })])}
        >
          {t('fieldChoices.addOption')}
        </button>
      </div>
      <div className="data-inline-choice-list">
        {choices.map((choice, index) => {
          const choiceKey = `${choice}-${index}`
          const tone =
            normalizeChoiceTone(choiceTones[choice] || '') ||
            getSelectTone(choice || choiceKey)
          return (
            <div key={choiceKey} className="data-inline-choice-row">
              <GripVertical className="size-4 text-muted-foreground" />
              <div className="data-inline-choice-tone-menu">
                <button
                  type="button"
                  className={cn('data-inline-choice-tone', `tone-${tone}`)}
                  title={t('fieldChoices.optionColor')}
                />
                <div className="data-inline-choice-tone-popover">
                  {selectPalette.map((item) => (
                    <button
                      key={item}
                      type="button"
                      className={cn(
                        'data-inline-choice-tone',
                        `tone-${item}`,
                        tone === item && 'is-active',
                      )}
                      title={t(`fieldChoices.colors.${item}`)}
                      onClick={() => updateChoiceTone(choice, item)}
                    />
                  ))}
                </div>
              </div>
              <Input
                value={choice}
                onChange={(event) => updateChoice(index, event.target.value)}
                placeholder={t('fieldChoices.optionName')}
              />
              <button
                type="button"
                className="data-inline-choice-remove"
                onClick={() => onChoicesChange(choices.filter((_, i) => i !== index))}
              >
                ×
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
