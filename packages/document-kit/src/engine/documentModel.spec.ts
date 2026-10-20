import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { kitEngineClass, type KitEngineDocument } from '@kition/kit-engine'
import { parseSchema, randomActor, Replica } from '@kition/kdm'
import { documentBody, documentSchema } from '@kition/document-editor/file'
import { COMMENT_COMMANDS, documentModel } from './documentModel'

const MarkdownDocument = kitEngineClass(documentModel)

const bytes = (text: string) => new TextEncoder().encode(text)
/** The file's bytes as text, its byte order mark kept. */
const text = (data: Uint8Array) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(data)
const run = (doc: KitEngineDocument, command: string, params: Record<string, unknown> = {}) => JSON.parse(doc.execute(command, JSON.stringify(params)))

describe('the Document kit engine', () => {
  it('declares the schema the code has (model/schema.json, rule K12) and its comment commands', () => {
    const file = JSON.parse(readFileSync(path.join(__dirname, '../../model/schema.json'), 'utf8'))
    expect(parseSchema(file)).toEqual(documentSchema)
    const manifest = JSON.parse(readFileSync(path.join(__dirname, '../../kit.json'), 'utf8'))
    expect(manifest.model.schemaVersion).toBe(documentSchema.schemaVersion)
    expect(manifest.id).toBe(documentSchema.kit)
    expect(manifest.collaboration.comments.commands).toEqual([...COMMENT_COMMANDS])
  })

  it('opens a Markdown file, edits its text, and saves it in the line style it was read in', () => {
    const doc = MarkdownDocument.open('Plan.md', bytes('\u{feff}# Plan\r\n\r\nGoals\r\n'))
    expect(JSON.parse(doc.inspect())).toMatchObject({ heading: 'Plan', characters: 14, lines: 4, threads: 0, canUndo: false })
    expect(doc.dirty).toBe(false)
    expect(run(doc, 'text.read', { from: 8, to: 13 })).toEqual({ text: 'Goals', length: 14 })
    run(doc, 'text.insert', { at: 14, text: 'Risks\n' })
    run(doc, 'text.replace', { from: 8, to: 13, text: 'Aims' })
    expect(doc.dirty).toBe(true)
    expect(text(doc.save('Plan.md'))).toBe('\u{feff}# Plan\r\n\r\nAims\r\nRisks\r\n')
    run(doc, 'text.delete', { from: 0, to: 8 })
    expect(text(doc.save())).toBe('\u{feff}Aims\r\nRisks\r\n')
    expect(() => run(doc, 'text.delete', { from: 4, to: 99 })).toThrow(/not a range/)
    expect(() => run(doc, 'document.explode')).toThrow(/no command document\.explode/)
  })

  it('replaces the whole text as the edits that differ, one undo step', () => {
    const doc = MarkdownDocument.open('Plan.md', bytes('# Plan\n\nGoals\n'))
    expect(run(doc, 'document.replace', { text: '# Plan\n\nGoals\n' })).toEqual({ changed: false })
    expect(run(doc, 'document.replace', { text: '# Plan\r\n\r\nGoals and risks\r\n' })).toEqual({ changed: true })
    expect(text(doc.save())).toBe('# Plan\n\nGoals and risks\n')
    expect(JSON.parse(doc.undo()).done).toBe(true)
    expect(text(doc.save())).toBe('# Plan\n\nGoals\n')
  })

  it('makes a new, empty document', () => {
    const doc = MarkdownDocument.create('Notes.md', 612, 792)
    expect(JSON.parse(doc.inspect())).toMatchObject({ heading: null, characters: 0, lines: 0 })
    run(doc, 'text.insert', { at: 0, text: '# Notes\n' })
    expect(text(doc.save())).toBe('# Notes\n')
  })

  it('opens a file with the replica stored for it: same document, the file wins, the merge is no edit', () => {
    const first = MarkdownDocument.open('Plan.md', bytes('# Plan\n\nGoals\n'))
    run(first, 'comment.add', { quote: 'Goals', body: 'Which quarter?' })
    first.markSaved()
    // Another writer changed the file meanwhile.
    const reopened = MarkdownDocument.openWithReplica('Plan.md', bytes('# Plan\n\nGoals\n\nRisks\n'), first.snapshot(), new Uint8Array(0))
    expect(reopened.docId).toBe(first.docId)
    expect(reopened.dirty).toBe(false)
    expect(reopened.canUndo()).toBe(false)
    expect(text(reopened.save())).toBe('# Plan\n\nGoals\n\nRisks\n')
    // The comments are the replica's: they survive the file, which has none.
    expect(run(reopened, 'comment.threads').threads).toHaveLength(1)
    // A server opening the replica alone.
    expect(documentBody(Replica.load(documentSchema, MarkdownDocument.openWithReplica('Plan.md', new Uint8Array(0), first.snapshot(), new Uint8Array(0)).snapshot(), randomActor()))).toBe('# Plan\n\nGoals\n')
  })

  it('exchanges changes with another replica of the document, both ways, and the two converge', () => {
    const first = MarkdownDocument.open('Plan.md', bytes('# Plan\n\nGoals\n'))
    const second = MarkdownDocument.openWithReplica('Plan.md', new Uint8Array(0), first.snapshot(), new Uint8Array(0))
    run(first, 'text.insert', { at: 0, text: 'Draft\n' })
    run(second, 'text.insert', { at: 14, text: 'Risks\n' })
    expect(JSON.parse(first.importChanges(second.exportChanges(first.version())))).toEqual({ kind: 'full' })
    second.importChanges(first.exportChanges(second.version()))
    expect(text(first.save())).toBe('Draft\n# Plan\n\nGoals\nRisks\n')
    expect(text(second.save())).toBe(text(first.save()))
    const state = (doc: KitEngineDocument) => Replica.load(documentSchema, doc.snapshot(), randomActor()).stateText()
    expect(state(first)).toBe(state(second))
    // The import is not the person's own: Undo takes back only their line.
    expect(JSON.parse(first.undo()).done).toBe(true)
    expect(text(first.save())).toBe('# Plan\n\nGoals\nRisks\n')
  })

  it('keeps comment threads beside the text, written as the person who runs the command', () => {
    const doc = MarkdownDocument.open('Plan.md', bytes('# Plan\n\nGoals\n'))
    const origin = (principal: string) => JSON.stringify(['person', principal, 'comment'])
    const { thread } = JSON.parse(doc.executeAs('comment.add', JSON.stringify({ quote: 'Goals', body: 'Which quarter?', name: 'Ada' }), origin('user:ada')))
    doc.executeAs('comment.reply', JSON.stringify({ thread, body: 'Q3' }), origin('user:bo'))
    // A host that knows who the person is says so.
    run(doc, 'comment.reply', { thread, body: 'Agreed', author: 'user:cy', name: 'Cy' })
    // Text typed before the quote moves the thread's range with it.
    run(doc, 'text.insert', { at: 0, text: 'Draft\n' })
    let [listed] = run(doc, 'comment.threads').threads
    expect(listed).toMatchObject({ id: thread, resolved: false, range: { start: 14, end: 19 } })
    expect(listed.comments.map((comment: { author: string; body: string }) => [comment.author, comment.body])).toEqual([['user:ada', 'Which quarter?'], ['user:bo', 'Q3'], ['user:cy', 'Agreed']])
    expect(listed.comments[0].name).toBe('Ada')
    run(doc, 'comment.resolve', { thread })
    expect(JSON.parse(doc.inspect())).toMatchObject({ threads: 1, openThreads: 0 })
    run(doc, 'comment.resolve', { thread, resolved: false })
    for (const comment of [...listed.comments].reverse()) run(doc, 'comment.delete', { thread, comment: comment.id })
    expect(run(doc, 'comment.threads').threads).toEqual([])
    // Comments never reach the Markdown file.
    expect(text(doc.save())).toBe('Draft\n# Plan\n\nGoals\n')
    expect(() => run(doc, 'comment.add', { quote: 'Nowhere', body: 'Hm' })).toThrow(/has no "Nowhere"/)
    expect(() => run(doc, 'comment.add', { body: '  ' })).toThrow(/needs a body/)
    listed = run(doc, 'comment.add', { body: 'On the whole document' })
    expect(listed.thread).toMatch(/\S/)
  })

  it('repairs the comment threads concurrent comment commands leave broken: a reply to a thread deleted meanwhile goes too', () => {
    const first = MarkdownDocument.open('Plan.md', bytes('# Plan\n\nGoals\n'))
    const { thread, comment } = run(first, 'comment.add', { quote: 'Goals', body: 'Which quarter?' })
    const second = MarkdownDocument.openWithReplica('Plan.md', new Uint8Array(0), first.snapshot(), new Uint8Array(0))
    run(second, 'comment.reply', { thread, body: 'Q3' })
    run(first, 'comment.delete', { thread, comment })
    first.importChanges(second.exportChanges(first.version()))
    second.importChanges(first.exportChanges(second.version()))
    const state = (doc: KitEngineDocument) => Replica.load(documentSchema, doc.snapshot(), randomActor())
    for (const doc of [first, second]) {
      expect(run(doc, 'comment.threads').threads).toEqual([])
      expect(state(doc).objectsOfType('Comment')).toEqual([])
    }
    expect(state(first).stateText()).toBe(state(second).stateText())
  })
})
