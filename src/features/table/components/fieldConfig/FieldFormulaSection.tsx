import { useTranslation } from 'react-i18next'
import type { DataField } from '@/types/dataDocument'
import { FormulaEditor } from '../formula/FormulaEditor'

export function FieldFormulaSection({
  formula,
  currentFieldId,
  fields,
  onChange,
}: {
  formula: string
  currentFieldId: number
  fields: DataField[]
  onChange: (next: string) => void
}) {
  const { t } = useTranslation('table')
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium">{t('fieldConfig.formula')}</span>
      <FormulaEditor
        value={formula}
        onChange={onChange}
        placeholder={t('fieldConfig.formulaPlaceholder')}
        fieldNames={fields.filter((f) => f.id !== currentFieldId).map((f) => f.name)}
      />
    </div>
  )
}
