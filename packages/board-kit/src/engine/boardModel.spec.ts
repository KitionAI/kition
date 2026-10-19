import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { kitEngineClass, type KitEngineDocument } from '@kition/kit-engine'
import { parseSchema, randomActor, Replica } from '@kition/kdm'
import { boardSchema, createBoardFromRecords, createBoardRecordsFromElements, decodeBoardFile, encodeBoardFile, readBoardRecords } from '@kition/board-editor/model'
import type { WhiteboardElement } from '@kition/board-editor'
import { boardModel } from './boardModel'

const BoardDocument = kitEngineClass(boardModel)

const note = (id: string, text: string, x = 0): WhiteboardElement => ({
  id,
  kind: 'rectangle',
  x,
  y: 0,
  width: 160,
  height: 100,
  text,
  shapeType: 'rectangle',
  shapeStyle: 'sticky',
}) as WhiteboardElement

/** A `.kiboard` file of a board titled `Plan` with `elements` on its first page. */
function boardFile(elements: WhiteboardElement[]) {
  const replica = createBoardFromRecords('Plan', randomActor(), createBoardRecordsFromElements(elements))
  return new TextEncoder().encode(encodeBoardFile(replica))
}

function elementTexts(bytes: Uint8Array) {
  const decoded = decodeBoardFile(new TextDecoder().decode(bytes), randomActor())
  if (decoded.kind !== 'board') throw new Error(decoded.reason)
  return readBoardRecords(decoded.replica)
    .flatMap((record) => (record.record_type === 'element' && 'text' in record ? [record.text ?? ''] : []))
    .sort()
}

describe('the Board kit engine', () => {
  it('declares the schema the code has (model/schema.json, rule K12)', () => {
    const file = JSON.parse(readFileSync(path.join(__dirname, '../../model/schema.json'), 'utf8'))
    expect(parseSchema(file)).toEqual(boardSchema)
    const manifest = JSON.parse(readFileSync(path.join(__dirname, '../../kit.json'), 'utf8'))
    expect(manifest.model.schemaVersion).toBe(boardSchema.schemaVersion)
    expect(manifest.id).toBe(boardSchema.kit)
  })

  it('opens a .kiboard file, runs board commands, and saves the same document', () => {
    const doc = BoardDocument.open('Plan.kiboard', boardFile([note('a', 'Goals')]))
    const before = JSON.parse(doc.inspect())
    expect(before).toMatchObject({ title: 'Plan', elements: 1, canUndo: false })
    expect(doc.dirty).toBe(false)
    const result = JSON.parse(doc.execute('element.create', JSON.stringify({ elements: [note('b', 'Risks', 200)] })))
    expect(result).toEqual({ added: ['b'], updated: [], removed: [] })
    expect(doc.dirty).toBe(true)
    expect(JSON.parse(doc.inspect())).toMatchObject({ elements: 2, canUndo: true })
    const saved = doc.save('Plan.kiboard')
    expect(elementTexts(saved)).toEqual(['Goals', 'Risks'])
    const decoded = decodeBoardFile(new TextDecoder().decode(saved), randomActor())
    expect(decoded.kind === 'board' && decoded.replica.docId).toBe(doc.docId)
    expect(() => doc.execute('board.explode', '{}')).toThrow(/no command board\.explode/)
  })

  it('makes a new board titled after its file', () => {
    const doc = BoardDocument.create('Roadmap.kiboard', 1920, 1080)
    expect(JSON.parse(doc.inspect())).toMatchObject({ title: 'Roadmap', elements: 0, pages: [{ name: 'Roadmap', elements: 0 }] })
    expect(elementTexts(doc.save())).toEqual([])
  })

  it('refuses files it does not open', () => {
    expect(() => BoardDocument.open('Old.kiboard', new TextEncoder().encode('{"format":"kition-board","version":1,"records":[]}'))).toThrow(/earlier Kition/)
    expect(() => BoardDocument.open('Note.kiboard', new TextEncoder().encode('hello'))).toThrow(/not a board/)
  })

  it('undoes its own command and patches the view from the replica', () => {
    const doc = BoardDocument.open('Plan.kiboard', boardFile([note('a', 'Goals')]))
    doc.execute('element.delete', JSON.stringify({ elementIds: ['a'] }))
    expect(JSON.parse(doc.inspect()).elements).toBe(0)
    expect(JSON.parse(doc.undo()).done).toBe(true)
    expect(JSON.parse(doc.inspect()).elements).toBe(1)
    expect(elementTexts(doc.save())).toEqual(['Goals'])
  })

  it('exchanges changes with another replica of the board, both ways, and the two converge', () => {
    const file = boardFile([note('a', 'Goals')])
    const first = BoardDocument.open('Plan.kiboard', file)
    const second = BoardDocument.open('Plan.kiboard', file)
    first.execute('element.create', JSON.stringify({ elements: [note('b', 'Risks', 200)] }))
    second.execute('element.update', JSON.stringify({ elements: [note('a', 'Goals for Q3')] }))
    second.execute('page.create', JSON.stringify({ pageId: 'p2', name: 'Later' }))
    const damage = JSON.parse(first.importChanges(second.exportChanges(first.version())))
    expect(damage).toEqual({ kind: 'full' })
    second.importChanges(first.exportChanges(second.version()))
    expect(elementTexts(first.save())).toEqual(['Goals for Q3', 'Risks'])
    expect(first.snapshot().length).toBeGreaterThan(0)
    const state = (doc: KitEngineDocument) => Replica.load(boardSchema, doc.snapshot(), randomActor()).stateText()
    expect(state(first)).toBe(state(second))
    const pages = (doc: KitEngineDocument) => JSON.parse(doc.inspect()).pages.map((page: { name: string }) => page.name)
    expect(pages(first)).toHaveLength(2)
    expect(pages(first)[1]).toBe('Later')
    expect(pages(second)).toEqual(pages(first))
    // The import is not the person's own: Undo takes back only their element.
    expect(JSON.parse(first.undo()).done).toBe(true)
    expect(elementTexts(first.save())).toEqual(['Goals for Q3'])
  })
})
