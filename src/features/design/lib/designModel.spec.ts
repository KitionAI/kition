import { describe, expect, it } from 'vitest'
import { createDesign, createDesignNode } from './designTypes'
import { applyDesignCommand, duplicateNodes } from './designCommands'
import {
  multiply,
  selectionBounds,
  translation,
  worldMatrix,
} from './designGeometry'
import { parseDesign, serializeDesign } from './designSerialization'
import { DesignStore } from './designStore'
function fixture() {
  return applyDesignCommand(createDesign(), {
    type: 'insert',
    nodes: [
      createDesignNode('text', {
        id: 'heading',
        text: 'A poster',
        transform: [0.8, 0.6, -0.6, 0.8, 210, 110],
      }),
      createDesignNode('rectangle', {
        id: 'shape',
        transform: [1.4, 0.3, 0.2, 0.7, 150, 640],
      }),
    ],
  })
}
describe('native Design document invariants', () => {
  it('round-trips editable content without persisting selection or viewport state', () => {
    const doc = fixture()
    expect(parseDesign(serializeDesign(doc))).toEqual(doc)
    const store = new DesignStore(doc)
    store.select(['heading'])
    store.preview({
      type: 'transform',
      ids: ['heading'],
      matrix: translation(100, 10),
    })
    expect(store.getSnapshot().document).toBe(doc)
    expect(store.getSnapshot().canUndo).toBe(false)
    store.cancel()
    expect(store.getSnapshot().preview).toBeNull()
  })
  it('preserves world geometry through transformed nested groups and ungrouping', () => {
    const doc = fixture(),
      grouped = applyDesignCommand(doc, {
        type: 'group',
        ids: ['shape', 'heading'],
      })
    const groupId = grouped.pages[0].children[0]
    expect(grouped.nodes[groupId].children).toEqual(['heading', 'shape'])
    for (const id of ['heading', 'shape'])
      worldMatrix(grouped, id).forEach((value, i) =>
        expect(value).toBeCloseTo(worldMatrix(doc, id)[i], 8),
      )
    const matrix = multiply(translation(-70, 44), [0.7, -0.7, 0.7, 0.7, 0, 0])
    const rotated = applyDesignCommand(grouped, {
      type: 'transform',
      ids: [groupId],
      matrix,
    })
    const result = applyDesignCommand(rotated, {
      type: 'ungroup',
      ids: [groupId],
    })
    for (const id of ['heading', 'shape'])
      worldMatrix(result, id).forEach((value, i) =>
        expect(value).toBeCloseTo(worldMatrix(rotated, id)[i], 8),
      )
  })
  it('does not transform locked descendants selected through the layer panel', () => {
    const grouped = applyDesignCommand(fixture(), {
        type: 'group',
        ids: ['shape', 'heading'],
      }),
      id = grouped.pages[0].children[0]
    const locked = applyDesignCommand(grouped, {
      type: 'patch',
      ids: [id],
      patch: { locked: true },
    })
    expect(
      applyDesignCommand(locked, {
        type: 'transform',
        ids: ['heading'],
        matrix: translation(20, 30),
      }),
    ).toBe(locked)
    expect(
      applyDesignCommand(locked, {
        type: 'patch',
        ids: [id],
        patch: { locked: false },
      }).nodes[id].locked,
    ).toBe(false)
  })
  it('remaps group and child IDs when copying without changing local child transforms', () => {
    const grouped = applyDesignCommand(fixture(), {
      type: 'group',
      ids: ['shape', 'heading'],
    })
    const copy = duplicateNodes(grouped, grouped.pages[0].children)
    expect(copy.nodes).toHaveLength(3)
    expect(copy.nodes.every((n) => !grouped.nodes[n.id])).toBe(true)
    expect(
      copy.nodes
        .find((n) => n.type === 'group')!
        .children.every((id) => copy.nodes.some((n) => n.id === id)),
    ).toBe(true)
  })
  it.each([
    (doc: ReturnType<typeof fixture>) => {
      doc.version = 2 as 1
    },
    (doc: ReturnType<typeof fixture>) => {
      doc.nodes.heading.transform[0] = Infinity
    },
    (doc: ReturnType<typeof fixture>) => {
      doc.nodes.heading.transform = [0, 0, 0, 0, 0, 0]
    },
    (doc: ReturnType<typeof fixture>) => {
      doc.nodes.heading.children = ['heading']
    },
    (doc: ReturnType<typeof fixture>) => {
      doc.pages[0].children.push('heading')
    },
    (doc: ReturnType<typeof fixture>) => {
      doc.pages[0].children = []
    },
    (doc: ReturnType<typeof fixture>) => {
      doc.assets.a = {
        id: 'a',
        path: '../outside.png',
        mimeType: 'image/png',
        width: 100,
        height: 100,
      }
    },
  ])(
    'rejects invalid and unsupported documents instead of replacing their contents',
    (mutate) => {
      const doc = fixture()
      mutate(doc)
      expect(() => parseDesign(JSON.stringify(doc))).toThrow()
    },
  )
  it('keeps crop coordinates in source pixels and rejects areas outside the asset', () => {
    const doc = createDesign()
    doc.assets.a = {
      id: 'a',
      path: 'Attachments/source.png',
      mimeType: 'image/png',
      width: 100,
      height: 80,
    }
    const n = createDesignNode('image', {
      id: 'photo',
      assetId: 'a',
      crop: { x: 10, y: 20, width: 70, height: 50 },
    })
    const image = applyDesignCommand(doc, { type: 'insert', nodes: [n] })
    const moved = applyDesignCommand(image, {
      type: 'transform',
      ids: ['photo'],
      matrix: [2, 0, 0, 2, 30, 40],
    })
    expect(moved.nodes.photo.crop).toEqual(n.crop)
    expect(() =>
      applyDesignCommand(image, {
        type: 'patch',
        ids: ['photo'],
        patch: { crop: { x: 90, y: 0, width: 70, height: 80 } },
      }),
    ).toThrow()
  })
  it('commits one gesture and one text session per undo step, with monotonic revisions', () => {
    const store = new DesignStore(fixture()),
      before = store.getSnapshot().document
    for (let x = 1; x <= 12; x++)
      store.preview({
        type: 'transform',
        ids: ['heading'],
        matrix: translation(x, 0),
      })
    store.commitPreview()
    store.undo()
    expect(store.getSnapshot().document.nodes).toEqual(before.nodes)
    const revision = store.getSnapshot().document.revision
    store.redo()
    expect(store.getSnapshot().document.revision).toBeGreaterThan(revision)
    store.execute(
      { type: 'patch', ids: ['heading'], patch: { text: 'N' } },
      'text:heading',
    )
    store.execute(
      { type: 'patch', ids: ['heading'], patch: { text: 'New heading' } },
      'text:heading',
    )
    store.endCoalescing()
    store.undo()
    expect(store.getSnapshot().document.nodes.heading.text).toBe('A poster')
  })
})

it('aligns a multi-selection in one undoable action', () => {
  const store = new DesignStore(fixture())
  const initial = store.getSnapshot().document
  store.execute({ type: 'align', ids: ['heading', 'shape'], axis: 'x' })
  store.undo()
  expect(store.getSnapshot().document.nodes).toEqual(initial.nodes)
})

it('derives group bounds from edited descendants', () => {
  const grouped = applyDesignCommand(fixture(), {
    type: 'group',
    ids: ['heading', 'shape'],
  })
  const group = grouped.pages[0].children[0]
  const before = selectionBounds(grouped, [group])
  const edited = applyDesignCommand(grouped, {
    type: 'transform',
    ids: ['heading'],
    matrix: translation(1500, 0),
  })
  expect(selectionBounds(edited, [group])).toEqual(
    selectionBounds(edited, ['heading', 'shape']),
  )
  expect(selectionBounds(edited, [group]).width).toBeGreaterThan(before.width)
})
