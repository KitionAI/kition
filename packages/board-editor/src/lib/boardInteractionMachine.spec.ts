import { describe, expect, it } from 'vitest'

import { BoardInteractionMachine } from './boardInteractionMachine'

describe('BoardInteractionMachine', () => {
  it('keeps one explicit interaction active until it is reset', () => {
    const machine = new BoardInteractionMachine()

    expect(machine.getState()).toEqual({ type: 'idle' })
    machine.start({
      type: 'panning',
      startScreen: { x: 10, y: 20 },
      viewport: { x: 0, y: 0, zoom: 1 },
    })

    expect(machine.getState().type).toBe('panning')
    expect(machine.reset().type).toBe('panning')
    expect(machine.getState()).toEqual({ type: 'idle' })
  })

  it('rejects overlapping gestures so live transactions cannot be orphaned', () => {
    const machine = new BoardInteractionMachine()
    machine.start({
      type: 'brushing',
      additive: false,
      initialSelection: [],
      startWorld: { x: 0, y: 0 },
    })

    expect(() => machine.start({
      type: 'connecting',
      connectorType: 'straight',
      startWorld: { x: 10, y: 10 },
      style: {
        dashStyle: 'solid',
        fillColor: 'white',
        fillStyle: 'none',
        opacity: 1,
        strokeColor: 'ink',
        strokeSize: 'm',
      },
    })).toThrow('Cannot start connecting while brushing is active')
  })
})
