import { describe, expect, it } from 'vitest'
import { activeKitDocument, markKitDocumentShown, registerKitConnection, type MountedKitDocument } from './kitConnections'

const document = (path: string): MountedKitDocument => ({ path, kitId: 'kit.slide', connection: {} as MountedKitDocument['connection'] })

describe('activeKitDocument', () => {
  it('answers the kit editor shown last that is still open', () => {
    expect(activeKitDocument()).toBeNull()
    const a = document('a.pptx')
    const b = document('b.pptx')
    const withdrawA = registerKitConnection(a)
    const withdrawB = registerKitConnection(b)
    markKitDocumentShown('a.pptx')
    expect(activeKitDocument()).toBe(a)
    markKitDocumentShown('b.pptx')
    expect(activeKitDocument()).toBe(b)
    markKitDocumentShown('a.pptx')
    expect(activeKitDocument()).toBe(a)
    withdrawA()
    expect(activeKitDocument()).toBe(b)
    withdrawB()
    expect(activeKitDocument()).toBeNull()
  })
})
