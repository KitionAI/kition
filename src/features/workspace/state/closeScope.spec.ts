import { describe, expect, it } from 'vitest'

import { selectItemsToClose, type CloseScope } from './closeScope'

const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
const ids = (list: Array<{ id: string }>) => list.map((item) => item.id)

describe('selectItemsToClose', () => {
  it.each<[CloseScope, string, string[]]>([
    ['others', 'b', ['a', 'c', 'd']],
    ['left', 'c', ['a', 'b']],
    ['left', 'a', []],
    ['right', 'b', ['c', 'd']],
    ['right', 'd', []],
    ['all', 'b', ['a', 'b', 'c', 'd']],
  ])('%s of %s', (scope, target, expected) => {
    expect(ids(selectItemsToClose(items, target, scope))).toEqual(expected)
  })

  it('closes nothing for an unknown target unless closing all', () => {
    expect(selectItemsToClose(items, 'zz', 'others')).toEqual([])
    expect(selectItemsToClose(items, 'zz', 'left')).toEqual([])
    expect(ids(selectItemsToClose(items, null, 'all'))).toEqual(['a', 'b', 'c', 'd'])
  })

  it('works with numeric ids and never mutates the input', () => {
    const sessions = [{ id: 1 }, { id: 2 }, { id: 3 }]
    const result = selectItemsToClose(sessions, 2, 'all')
    expect(result).not.toBe(sessions)
    expect(selectItemsToClose(sessions, 2, 'right')).toEqual([{ id: 3 }])
  })
})
