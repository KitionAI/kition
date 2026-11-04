import { describe, expect, it } from 'vitest'
import { activeKitDocument, markKitDocumentShown, registerKitConnection, subscribeActiveKitDocument, type MountedKitDocument } from './kitConnections'

const document = (path: string): MountedKitDocument => ({ path, kitId: 'kit.slide', connection: {} as MountedKitDocument['connection'] })

describe('activeKitDocument', () => {
  it('notifies activation after registration, tab switches and fallback on close', () => {
    const heard: Array<MountedKitDocument | null> = []
    const unsubscribe = subscribeActiveKitDocument(() => heard.push(activeKitDocument()))
    const a = document('pending.kfig')
    const b = document('second.kfig')
    const withdrawA = registerKitConnection(a)
    expect(heard).toEqual([])
    markKitDocumentShown(a.path)
    markKitDocumentShown(a.path)
    expect(heard).toEqual([a])
    const withdrawB = registerKitConnection(b)
    expect(heard).toEqual([a])
    markKitDocumentShown(b.path)
    withdrawB()
    withdrawA()
    expect(heard).toEqual([a, b, a, null])
    unsubscribe()
    const withdraw = registerKitConnection(a)
    markKitDocumentShown(a.path)
    withdraw()
    expect(heard).toEqual([a, b, a, null])
  })

  it('notifies a replacement connection without treating the old cleanup as a close', () => {
    const a = document('replacement.kfig')
    const b = document(a.path)
    const heard: Array<MountedKitDocument | null> = []
    const unsubscribe = subscribeActiveKitDocument(() => heard.push(activeKitDocument()))
    markKitDocumentShown(a.path)
    const withdrawA = registerKitConnection(a)
    const withdrawB = registerKitConnection(b)
    withdrawA()
    expect(heard).toEqual([a, b])
    withdrawB()
    expect(heard).toEqual([a, b, null])
    unsubscribe()
  })

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
