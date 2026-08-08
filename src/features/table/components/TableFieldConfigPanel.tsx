import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { DataDateFormat, DataField, DataFieldType } from '@/types/dataDocument'
import { normalizeAIConfig, type AnyAIConfig } from '@/types/aiConfig'
import { Button } from '@/components/ui'
import { RightSheet } from '@/components/RightSheet'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogClose,
} from '@/registry/ui/dialog'
import {
  getChoiceToneMap,
  getFieldTone,
  getSelectTone,
  normalizeChoiceList,
  normalizeChoiceTone,
  type FieldSaveUpdates,
} from '@/features/table/lib/tableEditorShared'

import { FieldNameSection } from './fieldConfig/FieldNameSection'
import { FieldTypeSection } from './fieldConfig/FieldTypeSection'
import { FieldValidationSection } from './fieldConfig/FieldValidationSection'
import { FieldChoicesSection } from './fieldConfig/FieldChoicesSection'
import { FieldFormulaSection } from './fieldConfig/FieldFormulaSection'
import { FieldAdvancedSection } from './fieldConfig/FieldAdvancedSection'
import { FieldAIConfigCard } from './fieldConfig/FieldAIConfigCard'
import { FieldShowAsSection, type LongTextShowAs } from './fieldConfig/FieldShowAsSection'
import { FieldDateFormatSection } from './fieldConfig/FieldDateFormatSection'
import { getTableDateFormat } from '@/features/table/lib/dateFormatting'

interface Draft {
  title: string
  description: string
  type: DataFieldType
  readonly: boolean
  choices: string[]
  choiceTones: Record<string, string>
  formula: string
  aiConfig: AnyAIConfig | undefined
  columnTone: string
  longTextShowAs: LongTextShowAs
  dateFormat: DataDateFormat
}

function draftFromField(field: DataField): Draft {
  const rawShowAs = field.options?.showAs
  const longTextShowAs: LongTextShowAs =
    rawShowAs === 'markdown' || rawShowAs === 'text' ? rawShowAs : 'text'
  return {
    title: field.title,
    description: typeof field.options?.description === 'string' ? field.options.description : '',
    type: field.type,
    readonly: field.readonly,
    choices: normalizeChoiceList(field),
    choiceTones: getChoiceToneMap(field),
    formula: field.formula || '',
    aiConfig: normalizeAIConfig(field.ai_config) ?? undefined,
    columnTone: getFieldTone(field),
    longTextShowAs,
    dateFormat: getTableDateFormat(field),
  }
}

function serializeDraft(d: Draft): string {
  return JSON.stringify(d)
}

export function FieldConfigPanel({
  field,
  fields,
  busy,
  onClose,
  onSave,
}: {
  field: DataField
  fields: DataField[]
  busy: boolean
  onClose: () => void
  onSave: (updates: FieldSaveUpdates) => void | Promise<void>
}) {
  const { t } = useTranslation(['table', 'common'])
  const [draft, setDraft] = useState<Draft>(() => draftFromField(field))
  const [originalSnapshot, setOriginalSnapshot] = useState<string>(() =>
    serializeDraft(draftFromField(field)),
  )
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const dirty = useMemo(() => serializeDraft(draft) !== originalSnapshot, [draft, originalSnapshot])

  useEffect(() => {
    if (dirty) return
    const next = draftFromField(field)
    setDraft(next)
    setOriginalSnapshot(serializeDraft(next))
  }, [field, dirty])

  function patch(partial: Partial<Draft>) {
    setDraft((current) => ({ ...current, ...partial }))
  }

  const supportsAI = draft.type === 'attachment' || draft.type === 'text' || draft.type === 'long_text'
  const isSelectType = draft.type === 'single_select' || draft.type === 'multi_select'
  const isFormulaType = draft.type === 'formula'
  const isLongText = draft.type === 'long_text'
  const isDateType = draft.type === 'date' || draft.type === 'datetime'

  function handleTypeChange(next: DataFieldType) {
    const currentIsDateType = draft.type === 'date' || draft.type === 'datetime'
    patch({
      type: next,
      ...(!currentIsDateType && (next === 'date' || next === 'datetime')
        ? { dateFormat: getTableDateFormat({ type: next }) }
        : {}),
    })
  }

  function buildUpdates(): FieldSaveUpdates {
    const selectChoices = draft.choices.map((c) => c.trim()).filter(Boolean)
    const nextChoiceTones = selectChoices.reduce<Record<string, string>>((acc, choice) => {
      acc[choice] = normalizeChoiceTone(draft.choiceTones[choice] || '') || getSelectTone(choice)
      return acc
    }, {})
    return {
      title: draft.title.trim() || field.title,
      type: draft.type,
      readonly: draft.readonly || isFormulaType,
      options: {
        ...(field.options || {}),
        column_tone: draft.columnTone,
        description: draft.description.trim() || undefined,
        ...(isSelectType ? { choices: selectChoices, choice_tones: nextChoiceTones } : {}),
        ai_config: supportsAI ? (draft.aiConfig ?? null) : null,
        showAs: isLongText ? draft.longTextShowAs : undefined,
        date_format: isDateType ? draft.dateFormat : undefined,
      },
      formula: isFormulaType ? draft.formula.trim() : field.formula,
    }
  }

  async function handleSave() {
    await onSave(buildUpdates())
    setOriginalSnapshot(serializeDraft(draft))
    onClose()
  }

  function attemptCancel() {
    if (!dirty) {
      onClose()
      return
    }
    setConfirmOpen(true)
  }

  function discardChanges() {
    const fresh = draftFromField(field)
    setDraft(fresh)
    setOriginalSnapshot(serializeDraft(fresh))
    setConfirmOpen(false)
    onClose()
  }

  return (
    <>
      <RightSheet
        open={true}
        onClose={onClose}
        dirty={dirty}
        onRequestClose={attemptCancel}
        title={t('fieldConfigPanel.editField')}
        footer={
          <>
            <Button variant="ghost" onClick={attemptCancel} disabled={busy}>
              {t('common:actions.cancel')}
            </Button>
            <Button onClick={() => void handleSave()} disabled={busy || !dirty}>
              {t('common:actions.save')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <FieldNameSection
            name={draft.title}
            description={draft.description}
            onNameChange={(next) => patch({ title: next })}
            onDescriptionChange={(next) => patch({ description: next })}
            onToggleAdvanced={() => setShowAdvanced((prev) => !prev)}
          />
          <FieldAdvancedSection
            open={showAdvanced}
            columnTone={draft.columnTone}
            fieldId={field.id}
            onColumnToneChange={(next) => patch({ columnTone: next })}
          />
          <FieldTypeSection
            type={draft.type}
            onChange={handleTypeChange}
          />
          {isDateType ? (
            <FieldDateFormatSection
              value={draft.dateFormat}
              onChange={(next) => patch({ dateFormat: next })}
            />
          ) : null}
          <hr className="border-border" />
          <FieldValidationSection
            readonly={draft.readonly}
            readonlyLocked={isFormulaType}
            onReadonlyChange={(next) => patch({ readonly: next })}
          />
          {isSelectType ? (
            <>
              <hr className="border-border" />
              <FieldChoicesSection
                choices={draft.choices}
                choiceTones={draft.choiceTones}
                onChoicesChange={(next) => patch({ choices: next })}
                onChoiceTonesChange={(next) => patch({ choiceTones: next })}
              />
            </>
          ) : null}
          {isFormulaType ? (
            <>
              <hr className="border-border" />
              <FieldFormulaSection
                formula={draft.formula}
                currentFieldId={field.id}
                fields={fields}
                onChange={(next) => patch({ formula: next })}
              />
            </>
          ) : null}
          {supportsAI ? (
            <>
              <hr className="border-border" />
              <FieldAIConfigCard
                field={{ ...field, type: draft.type }}
                fields={fields}
                value={draft.aiConfig}
                onChange={(next) => patch({ aiConfig: next })}
              />
            </>
          ) : null}
          {isLongText ? (
            <>
              <hr className="border-border" />
              <FieldShowAsSection
                value={draft.longTextShowAs}
                onChange={(next) => patch({ longTextShowAs: next })}
              />
            </>
          ) : null}
        </div>
      </RightSheet>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>{t('fieldConfigPanel.saveChangesTitle')}</DialogTitle>
          </DialogHeader>
          <p className="px-6 text-sm text-muted-foreground">
            {t('fieldConfigPanel.unsavedChanges')}
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
              {t('fieldConfigPanel.continueEditing')}
            </Button>
            <Button variant="destructive" onClick={discardChanges}>
              {t('fieldConfigPanel.discard')}
            </Button>
            <Button onClick={() => void handleSave().then(() => setConfirmOpen(false))} disabled={busy}>
              {t('common:actions.save')}
            </Button>
          </DialogFooter>
          <DialogClose />
        </DialogContent>
      </Dialog>
    </>
  )
}
