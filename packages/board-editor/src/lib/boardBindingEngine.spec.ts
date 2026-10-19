import { describe, expect, it } from 'vitest'

import {
  getBoardConnectorAnchor,
  resolveBoardConnectorAnchor,
} from './boardBindingEngine'
import { BoardCommandRegistry } from './boardCommands'
import {
  createBoardRecordsFromElements,
  type BoardBindingRecord,
} from './boardRecords'
import { BoardStore } from './boardStore'
import type { WhiteboardElement } from './whiteboardTypes'

describe('boardBindingEngine', () => {
  it('stores a normalized edge anchor that follows target transforms', () => {
    const target: WhiteboardElement = {
      id: 'target',
      kind: 'rectangle',
      x: 100,
      y: 80,
      width: 200,
      height: 100,
    }
    const anchor = getBoardConnectorAnchor(target, { x: 100, y: 120 })

    expect(anchor).toMatchObject({
      targetElementId: 'target',
      targetAnchor: { x: 0, y: 0.4 },
      point: { x: 100, y: 120 },
    })
    expect(resolveBoardConnectorAnchor({
      ...target,
      x: 300,
      width: 400,
    }, anchor!.targetAnchor)).toEqual({ x: 300, y: 120 })
  })

  it('creates durable endpoint bindings and updates the connector in the same undo step', () => {
    const targets: WhiteboardElement[] = [
      { id: 'left', kind: 'rectangle', x: 0, y: 0, width: 100, height: 80 },
      { id: 'right', kind: 'rectangle', x: 200, y: 0, width: 100, height: 80 },
    ]
    const store = new BoardStore(createBoardRecordsFromElements(targets))
    const commands = new BoardCommandRegistry(store)
    const startAnchor = getBoardConnectorAnchor(targets[0], { x: 100, y: 40 })!
    const endAnchor = getBoardConnectorAnchor(targets[1], { x: 200, y: 40 })!

    commands.execute({
      type: 'connector.create',
      element: {
        id: 'connector',
        kind: 'connector',
        start: startAnchor.point,
        end: endAnchor.point,
      },
      bindings: [
        { anchor: startAnchor, terminal: 'start' },
        { anchor: endAnchor, terminal: 'end' },
      ],
    })

    expect(store.getRecords().filter((record): record is BoardBindingRecord => (
      record.record_type === 'binding'
    ))).toEqual([
      expect.objectContaining({ from_id: 'connector', terminal: 'end', to_id: 'right' }),
      expect.objectContaining({ from_id: 'connector', terminal: 'start', to_id: 'left' }),
    ])

    commands.execute({
      type: 'element.update',
      elements: [{
        ...(targets[1] as Extract<WhiteboardElement, { kind: 'rectangle' }>),
        x: 320,
      }],
    })
    expect(store.getCurrentPageElements().find((element) => element.id === 'connector'))
      .toMatchObject({ end: { x: 320, y: 40 } })

    store.undo()
    expect(store.getCurrentPageElements().find((element) => element.id === 'connector'))
      .toMatchObject({ end: { x: 200, y: 40 } })
  })

  it('removes endpoint bindings when either side is deleted', () => {
    const target: WhiteboardElement = {
      id: 'target',
      kind: 'rectangle',
      x: 0,
      y: 0,
      width: 100,
      height: 80,
    }
    const store = new BoardStore(createBoardRecordsFromElements([target]))
    const commands = new BoardCommandRegistry(store)
    const anchor = getBoardConnectorAnchor(target, { x: 100, y: 40 })!
    commands.execute({
      type: 'connector.create',
      element: {
        id: 'connector',
        kind: 'connector',
        start: anchor.point,
        end: { x: 180, y: 40 },
      },
      bindings: [{ anchor, terminal: 'start' }],
    })

    commands.execute({ type: 'element.delete', elementIds: ['target'] })

    expect(store.getRecord('binding:connector:start')).toBeNull()
    expect(store.getElementRecord('connector')).not.toBeNull()
  })

  it('repairs endpoints and drops dangling or duplicate bindings during load', () => {
    const records = [
      ...createBoardRecordsFromElements([
        { id: 'target', kind: 'rectangle', x: 100, y: 40, width: 120, height: 80 },
        {
          id: 'connector',
          kind: 'connector',
          start: { x: 0, y: 0 },
          end: { x: 20, y: 20 },
        },
      ]),
      {
        record_type: 'binding',
        id: 'binding:connector:start',
        binding_type: 'connector',
        from_id: 'connector',
        to_id: 'target',
        terminal: 'start',
        to_anchor: { x: 0, y: 0.5 },
      } satisfies BoardBindingRecord,
      {
        record_type: 'binding',
        id: 'binding:connector:start-copy',
        binding_type: 'connector',
        from_id: 'connector',
        to_id: 'target',
        terminal: 'start',
        to_anchor: { x: 1, y: 0.5 },
      } satisfies BoardBindingRecord,
      {
        record_type: 'binding',
        id: 'binding:missing:end',
        binding_type: 'connector',
        from_id: 'connector',
        to_id: 'missing',
        terminal: 'end',
        to_anchor: { x: 0, y: 0.5 },
      } satisfies BoardBindingRecord,
    ]

    const store = new BoardStore(records)

    expect(store.getCurrentPageElements().find((element) => element.id === 'connector'))
      .toMatchObject({ start: { x: 100, y: 80 }, end: { x: 20, y: 20 } })
    expect(store.getRecords().filter((record) => record.record_type === 'binding'))
      .toEqual([
        expect.objectContaining({ id: 'binding:connector:start' }),
      ])
  })
})
