import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

import { lightGridTheme } from '../../configs'
import { CellType, type ITextCell } from '../../renderers'
import { TextEditor } from './TextEditor'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement | null = null
let root: Root | null = null

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container?.remove()
  container = null
})

describe('TextEditor focus treatment', () => {
  it('uses one active border without the shared input focus ring', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(
        createElement(TextEditor, {
          cell: {
            type: CellType.Text,
            data: 'Draft',
            displayData: 'Draft',
            contentAlign: 'center',
          } as ITextCell,
          rect: { x: 0, y: 0, width: 120, height: 56, editorId: 'editor-test' },
          theme: lightGridTheme,
          isEditing: true,
          onChange: () => undefined,
        }),
      )
    })

    const input = container.querySelector('input')
    expect(input).not.toBeNull()
    expect(input?.className).not.toContain('focus:ring-2')
    expect(input?.style.border).toBe('2px solid rgb(86, 69, 212)')
    expect(input?.style.textAlign).toBe('center')
    expect(input?.style.paddingBottom).toBe('')
    expect(lightGridTheme.cellLineColorActived).toBe('#5645d4')
  })

  it('uses the compact table date editor instead of the native datetime picker', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(
        createElement(TextEditor, {
          cell: {
            type: CellType.Text,
            data: '2026-07-23T04:14:47Z',
            displayData: '2026/07/23 12:14',
            inputType: 'datetime-local',
          } as ITextCell,
          rect: { x: 0, y: 0, width: 180, height: 56, editorId: 'editor-date-test' },
          theme: lightGridTheme,
          isEditing: true,
          onChange: () => undefined,
        }),
      )
    })

    const editor = container.querySelector('[data-testid="table-date-cell-editor"]')
    expect(editor).not.toBeNull()
    expect(editor?.textContent).toContain('2026-07-23')
    expect(editor?.textContent).toContain('12:14')
    expect(container.querySelector('input[type="datetime-local"]')).toBeNull()
    expect(document.querySelector('[data-testid="table-date-calendar"]')).not.toBeNull()
  })
})
