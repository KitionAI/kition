import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  buildImageContextMenu,
  readImageEmbedWidth,
  removeImageSource,
  resetImageEmbedSize,
} from './image-widget-actions'

const views: EditorView[] = []

function makeView(doc: string) {
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc }),
  })
  views.push(view)
  return view
}

afterEach(() => {
  while (views.length) views.pop()?.destroy()
  document.querySelectorAll('.document-menu-portal').forEach((node) => node.remove())
  vi.restoreAllMocks()
})

describe('image widget actions', () => {
  it('reads embedded width and width-by-height values', () => {
    expect(readImageEmbedWidth('![[image.png|320]]')).toBe(320)
    expect(readImageEmbedWidth('![[image.png|Diagram|640x480]]')).toBe(640)
    expect(readImageEmbedWidth('![Diagram](image.png)')).toBeNull()
  })

  it('removes only size tokens while preserving an image label', () => {
    expect(resetImageEmbedSize('![[image.png|Diagram|640x480]]')).toBe('![[image.png|Diagram]]')
    expect(resetImageEmbedSize('![[image.png|Diagram]]')).toBe('![[image.png|Diagram]]')
  })

  it('removes a standalone image line without leaving an empty line', () => {
    const source = '![[image.png]]\nafter'
    const view = makeView(source)

    removeImageSource(view, 0, '![[image.png]]'.length, true)

    expect(view.state.doc.toString()).toBe('after')
  })

  it('builds a clickable image menu and enables reset only for sized embeds', () => {
    const source = '![[image.png|320]]'
    const view = makeView(source)
    const menu = buildImageContextMenu({
      view,
      imageSrc: 'https://example.com/image.png',
      sourceFrom: 0,
      sourceTo: source.length,
      block: true,
    })

    expect(menu.items).toHaveLength(4)
    expect(menu.items[0]).toMatchObject({ kind: 'item', title: 'Copy image' })
    expect(menu.items[1]).toMatchObject({ kind: 'item', title: 'Remove image', warning: true })
    expect(menu.items[3]).toMatchObject({ kind: 'item', title: 'Reset size', disabled: false })
  })
})
