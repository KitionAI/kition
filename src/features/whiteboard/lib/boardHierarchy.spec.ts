import { describe, expect, it } from 'vitest'

import {
  cloneBoardElementTrees,
  getBoardElementsWithDescendants,
  repairBoardHierarchyRecords,
  resolveBoardSelectableElementId,
} from './boardHierarchy'
import {
  createBoardElementRecord,
  createBoardRecordsFromElements,
} from './boardRecords'
import type { WhiteboardElement } from './whiteboardTypes'

const ELEMENTS: WhiteboardElement[] = [
  {
    id: 'frame',
    kind: 'rectangle',
    x: 0,
    y: 0,
    width: 400,
    height: 300,
    shapeStyle: 'frame',
    shapeType: 'frame',
  },
  {
    id: 'group',
    kind: 'rectangle',
    parentId: 'frame',
    x: 20,
    y: 30,
    width: 200,
    height: 140,
    shapeStyle: 'group',
  },
  {
    id: 'child',
    kind: 'rectangle',
    parentId: 'group',
    x: 40,
    y: 50,
    width: 80,
    height: 60,
  },
]

describe('boardHierarchy', () => {
  it('resolves child selection to the outer container and expands transforms', () => {
    expect(resolveBoardSelectableElementId(ELEMENTS, 'child')).toBe('frame')
    expect(getBoardElementsWithDescendants(ELEMENTS, ['group']).map((element) => element.id))
      .toEqual(['group', 'child'])
  })

  it('clones a tree with remapped internal parents and stable root IDs', () => {
    const cloned = cloneBoardElementTrees(ELEMENTS, ['group'])
    const group = cloned.elements.find((element) => (
      element.kind === 'rectangle' && element.shapeStyle === 'group'
    ))!
    const child = cloned.elements.find((element) => element.id !== group.id)!

    expect(cloned.rootIds).toEqual([group.id])
    expect(group.parentId).toBe('frame')
    expect(child.parentId).toBe(group.id)
    expect(new Set(cloned.elements.map((element) => element.id)).size).toBe(2)
  })

  it('repairs missing, non-container, and cyclic parents deterministically', () => {
    const records = createBoardRecordsFromElements([
      { id: 'plain', kind: 'rectangle', x: 0, y: 0, width: 80, height: 60 },
      {
        id: 'invalid-child',
        kind: 'rectangle',
        parentId: 'plain',
        x: 10,
        y: 10,
        width: 40,
        height: 30,
      },
    ]).filter((record) => record.record_type === 'element')
    records.push(createBoardElementRecord({
      element: {
        id: 'cycle-a',
        kind: 'rectangle',
        parentId: 'cycle-b',
        shapeStyle: 'group',
        x: 0,
        y: 0,
        width: 100,
        height: 80,
      },
      index: 2,
      pageId: 'page:main',
    }))
    records.push(createBoardElementRecord({
      element: {
        id: 'cycle-b',
        kind: 'rectangle',
        parentId: 'cycle-a',
        shapeStyle: 'group',
        x: 0,
        y: 0,
        width: 100,
        height: 80,
      },
      index: 3,
      pageId: 'page:main',
    }))

    expect(repairBoardHierarchyRecords(records).map((record) => ({
      id: record.id,
      parentId: record.parentId,
    }))).toEqual([
      { id: 'plain', parentId: undefined },
      { id: 'invalid-child', parentId: undefined },
      { id: 'cycle-a', parentId: undefined },
      { id: 'cycle-b', parentId: undefined },
    ])
  })
})
