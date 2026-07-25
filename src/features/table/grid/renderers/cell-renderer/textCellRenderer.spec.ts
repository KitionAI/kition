import { describe, expect, it, vi } from 'vitest'

import { CellRegionType, CellType, type ITextCell } from './interface'
import { textCellRenderer } from './textCellRenderer'

describe('textCellRenderer date editing', () => {
  it('requests editing when an editable date cell is clicked', () => {
    const callback = vi.fn()
    const cell = {
      type: CellType.Text,
      data: '2026-07-23',
      displayData: '2026/07/23',
      inputType: 'date',
      isEditingOnClick: true,
      readonly: false,
    } as ITextCell

    textCellRenderer.onClick?.(cell, {} as never, callback)

    expect(callback).toHaveBeenCalledWith({
      type: CellRegionType.ToggleEditing,
      data: null,
    })
  })

  it('does not open the editor for readonly date cells', () => {
    const callback = vi.fn()
    const cell = {
      type: CellType.Text,
      data: '2026-07-23',
      displayData: '2026/07/23',
      inputType: 'date',
      isEditingOnClick: true,
      readonly: true,
    } as ITextCell

    textCellRenderer.onClick?.(cell, {} as never, callback)

    expect(callback).not.toHaveBeenCalled()
  })
})
