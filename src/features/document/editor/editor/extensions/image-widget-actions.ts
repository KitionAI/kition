import type { EditorView } from '@codemirror/view'
import i18next from 'i18next'

import { notify } from '@/lib/notify'
import { copyImageToClipboard } from '@/services/desktop'
import { Menu } from '../../menu'

export type DocumentImagePreviewRequest = {
  src: string
  alt: string
}

type ImageWidgetActionOptions = {
  view: EditorView
  imageSrc: string
  sourceFrom: number
  sourceTo: number
  block: boolean
}

const IMAGE_SIZE_PATTERN = /^\d+(?:x\d+)?$/i

export function readImageEmbedWidth(source: string): number | null {
  const match = /^!\[\[([^\]]+)\]\]$/.exec(source.trim())
  if (!match) return null
  const parts = match[1].split('|').map((part) => part.trim())
  for (let index = parts.length - 1; index >= 1; index -= 1) {
    if (!IMAGE_SIZE_PATTERN.test(parts[index])) continue
    const width = Number(parts[index].split('x')[0])
    return Number.isFinite(width) && width > 0 ? width : null
  }
  return null
}

export function resetImageEmbedSize(source: string): string {
  const leading = source.match(/^\s*/)?.[0] || ''
  const trailing = source.match(/\s*$/)?.[0] || ''
  const trimmed = source.trim()
  const match = /^!\[\[([^\]]+)\]\]$/.exec(trimmed)
  if (!match) return source

  const parts = match[1].split('|')
  const nextParts = parts.filter((part, index) => (
    index === 0 || !IMAGE_SIZE_PATTERN.test(part.trim())
  ))
  if (nextParts.length === parts.length) return source
  return `${leading}![[${nextParts.join('|')}]]${trailing}`
}

export function removeImageSource(
  view: EditorView,
  sourceFrom: number,
  sourceTo: number,
  block: boolean,
  userEvent = 'delete.image.context-menu',
): void {
  let from = sourceFrom
  let to = sourceTo
  if (block) {
    const line = view.state.doc.lineAt(sourceFrom)
    const before = view.state.doc.sliceString(line.from, sourceFrom)
    const after = view.state.doc.sliceString(sourceTo, line.to)
    if (!before.trim() && !after.trim()) {
      from = line.from
      to = line.to < view.state.doc.length ? line.to + 1 : line.to
    }
  }

  view.dispatch({
    changes: { from, to, insert: '' },
    selection: { anchor: from },
    userEvent,
  })
  view.focus()
}

export function buildImageContextMenu({
  view,
  imageSrc,
  sourceFrom,
  sourceTo,
  block,
}: ImageWidgetActionOptions): Menu {
  const t = i18next.getFixedT(null, 'document')
  const menu = new Menu()
  const source = view.state.doc.sliceString(sourceFrom, sourceTo)
  const resetSource = resetImageEmbedSize(source)
  const readOnly = view.state.readOnly

  menu.addItem((item) => item
    .setTitle(t('editor.image.copy'))
    .setIcon('copy')
    .onSelect(() => {
      void copyImageToClipboard(imageSrc)
        .then(() => notify.success(t('editor.image.copied')))
        .catch((error) => notify.error(t('editor.image.copyFailed'), {
          description: error instanceof Error ? error.message : String(error),
        }))
    }))
  menu.addItem((item) => item
    .setTitle(t('editor.image.remove'))
    .setIcon('trash-2')
    .setWarning(true)
    .setDisabled(readOnly)
    .onSelect(() => removeImageSource(view, sourceFrom, sourceTo, block)))
  menu.addSeparator()
  menu.addItem((item) => item
    .setTitle(t('editor.image.resetSize'))
    .setIcon('rotate-ccw')
    .setDisabled(readOnly || resetSource === source)
    .onSelect(() => {
      view.dispatch({
        changes: { from: sourceFrom, to: sourceTo, insert: resetSource },
        selection: { anchor: sourceFrom + resetSource.length },
        userEvent: 'input.image.reset-size',
      })
      view.focus()
    }))

  return menu
}
