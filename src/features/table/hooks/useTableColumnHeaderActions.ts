import type { Dispatch, SetStateAction } from 'react'
import { useTranslation } from 'react-i18next'
import {
  createDataField,
  duplicateDataField,
} from '@/api/dataDocuments'
import type {
  DataDocument,
  DataField,
  DataRecord,
  DataTable,
} from '@/types/dataDocument'
import {
  createEmptyFilterCondition,
  createEmptyFilterGroup,
  normalizeAttachmentValue,
  type DataInlineFilterGroup,
  type DataInlineGroupItem,
  type DataInlineSortItem,
  type ToolbarPanel,
} from '@/features/table/lib/tableEditorShared'

type UseTableColumnHeaderActionsArgs = {
  document: DataDocument | null
  activeTable: DataTable | null
  records: DataRecord[]
  visibleFields: DataField[]
  sortItems: DataInlineSortItem[]
  setBusy: Dispatch<SetStateAction<boolean>>
  setError: Dispatch<SetStateAction<string>>
  setEditingField: Dispatch<SetStateAction<DataField | null>>
  setFilterTree: Dispatch<SetStateAction<DataInlineFilterGroup | null>>
  setSortItems: Dispatch<SetStateAction<DataInlineSortItem[]>>
  setGroupItems: Dispatch<SetStateAction<DataInlineGroupItem[]>>
  setFrozenColumnCount: Dispatch<SetStateAction<number>>
  setHiddenFieldNames: Dispatch<SetStateAction<Set<string>>>
  setToolbarPanel: Dispatch<SetStateAction<ToolbarPanel>>
  refreshDocument: (preferredTableId?: number | null, preferredViewId?: number | null) => Promise<void>
  copyTextToClipboard: (text: string, successMessage: string) => Promise<void>
  setStatus: (message: string) => void
}

export function useTableColumnHeaderActions({
  document,
  activeTable,
  records,
  visibleFields,
  sortItems,
  setBusy,
  setError,
  setEditingField,
  setFilterTree,
  setSortItems,
  setGroupItems,
  setFrozenColumnCount,
  setHiddenFieldNames,
  setToolbarPanel,
  refreshDocument,
  copyTextToClipboard,
  setStatus,
}: UseTableColumnHeaderActionsArgs) {
  const { t } = useTranslation('table')
  async function duplicateField(field: DataField) {
    if (!document || !activeTable) return
    setBusy(true)
    try {
      const created = await duplicateDataField(document.id, activeTable.id, field.id)
      await refreshDocument(activeTable.id)
      setStatus(t('feedback.fieldDuplicated'))
      setEditingField(created)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to duplicate field')
    } finally {
      setBusy(false)
    }
  }

  async function insertField(side: 'before' | 'after', anchor: DataField) {
    if (!document || !activeTable) return
    setBusy(true)
    try {
      const insertOrder = side === 'before' ? anchor.order : anchor.order + 1
      const created = await createDataField(document.id, activeTable.id, {
        title: 'New field',
        type: 'text',
        order: insertOrder,
      })
      await refreshDocument(activeTable.id)
      setEditingField(created)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to insert field')
    } finally {
      setBusy(false)
    }
  }

  async function copyColumnValuesForChat(field: DataField) {
    const values = records
      .map((record) => record.values?.[field.name])
      .filter((value) => value !== null && value !== undefined && value !== '')
    await copyTextToClipboard(
      JSON.stringify({ [field.title]: values }, null, 2),
      'Column copied for chat',
    )
  }

  function downloadAllFiles(field: DataField) {
    let count = 0
    for (const record of records) {
      const attachments = normalizeAttachmentValue(record.values?.[field.name])
      for (const attachment of attachments) {
        if (!attachment.url) continue
        const anchor = window.document.createElement('a')
        anchor.href = attachment.url
        anchor.download = attachment.name || ''
        anchor.rel = 'noreferrer'
        window.document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
        count += 1
      }
    }
    if (count === 0) {
      setStatus(t('feedback.noFilesToDownload'))
    } else {
      setStatus(`Downloading ${count} file${count === 1 ? '' : 's'}`)
    }
  }

  function addFilterForField(field: DataField) {
    setFilterTree((tree) => {
      const next = tree ? { ...tree, children: [...tree.children] } : createEmptyFilterGroup('and')
      const condition = createEmptyFilterCondition()
      condition.field_name = field.name
      next.children = [...next.children.filter((child) => {
        return !(child.kind === 'condition' && child.field_name === '' && child.value === '')
      }), condition]
      return next
    })
    setToolbarPanel('filter')
  }

  function addSortForField(field: DataField) {
    if (sortItems.some((item) => item.field_name === field.name)) {
      setToolbarPanel('sort')
      return
    }
    const next: DataInlineSortItem = {
      id: `sort_${Date.now().toString(36)}_${field.id}`,
      field_name: field.name,
      direction: 'asc',
    }
    setSortItems([...sortItems, next])
    setToolbarPanel('sort')
  }

  function setGroupField(field: DataField) {
    setGroupItems([{
      id: `grp_${Date.now().toString(36)}_${field.id}`,
      field_name: field.name,
      direction: 'asc',
    }])
    setToolbarPanel('group')
  }

  function freezeUpToField(field: DataField) {
    const index = visibleFields.findIndex((item) => item.id === field.id)
    if (index < 0) return
    setFrozenColumnCount(index + 1)
  }

  function hideField(field: DataField) {
    if (field.is_primary) return
    setHiddenFieldNames((current) => {
      const next = new Set(current)
      next.add(field.name)
      return next
    })
  }

  return {
    addFilterForField,
    addSortForField,
    copyColumnValuesForChat,
    downloadAllFiles,
    duplicateField,
    freezeUpToField,
    hideField,
    insertField,
    setGroupField,
  }
}
