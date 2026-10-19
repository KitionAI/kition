import { EditorState, Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'
import { person, randomActor, Replica } from '@kition/kdm'
import { documentSchema } from './documentSchema'
import { createDocumentReplica, documentBody } from './documentText'
import { replicaTextSource, type DocumentTextSource } from './documentTextSource'
import { exportMarkdownFile, importMarkdownFile, NEW_FILE_STYLE, openStoredMarkdownFile } from './markdownFile'

const views: EditorView[] = []
afterEach(() => views.splice(0).forEach((view) => view.destroy()))

/** An editor bound to `source`, as `DocumentEditor` binds one. */
function mount(source: DocumentTextSource) {
  const binding = source.createBinding()
  const view = new EditorView({ parent: document.body, state: EditorState.create({ doc: source.text(), extensions: [binding.extension, source.historyExtension()] }) })
  views.push(view)
  return view
}

/** Types `text` at the end, one keystroke at a time, as `input.type` transactions. */
function type(view: EditorView, text: string) {
  for (const character of text) {
    const end = view.state.doc.length
    view.dispatch({ changes: { from: end, insert: character }, annotations: Transaction.userEvent.of('input.type') })
  }
}

const bytes = (text: string) => new TextEncoder().encode(text)
const text = (data: Uint8Array) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(data)

describe('replicaTextSource', () => {
  it('edits a replica its caller keeps, and undoes a run of typing as one step when it groups typing', () => {
    const { replica, rootId } = createDocumentReplica('# Plan\n', randomActor())
    const source = replicaTextSource(replica, rootId, { groupTyping: true })
    const view = mount(source)
    type(view, 'Goals')
    expect(documentBody(replica)).toBe('# Plan\nGoals')
    source.replaceText('# Plan\nGoals\nRisks\n', person('user:local', 'paste'))
    expect(replica.undo()).toBe(true)
    expect(documentBody(replica)).toBe('# Plan\nGoals')
    expect(replica.undo()).toBe(true)
    expect(documentBody(replica)).toBe('# Plan\n')
    expect(replica.canUndo()).toBe(false)
  })

  it('makes each edit its own step without grouping', () => {
    const { replica, rootId } = createDocumentReplica('', randomActor())
    const view = mount(replicaTextSource(replica, rootId))
    type(view, 'ab')
    expect(replica.undo()).toBe(true)
    expect(documentBody(replica)).toBe('a')
  })
})

describe('Markdown files as replicas', () => {
  it('imports a file and exports it in the line style it was read in', () => {
    const file = '\u{feff}# Plan\r\n\r\nGoals\r\n'
    const { replica, style } = importMarkdownFile(bytes(file), randomActor())
    expect(documentBody(replica)).toBe('# Plan\n\nGoals\n')
    expect(text(exportMarkdownFile(replica, style))).toBe(file)
    expect(text(exportMarkdownFile(replica, NEW_FILE_STYLE))).toBe('# Plan\n\nGoals\n')
  })

  it('opens the replica stored for a file and takes what the file changed as one import, never an undo step', () => {
    const { replica } = importMarkdownFile(bytes('# Plan\n\nGoals\n'), randomActor())
    const opened = openStoredMarkdownFile(bytes('# Plan\n\nGoals\n\nRisks\n'), replica.snapshot(), randomActor())
    expect(opened.replica.docId).toBe(replica.docId)
    expect(documentBody(opened.replica)).toBe('# Plan\n\nGoals\n\nRisks\n')
    expect(opened.replica.canUndo()).toBe(false)
    const alone = openStoredMarkdownFile(new Uint8Array(0), replica.snapshot(), randomActor())
    expect(documentBody(Replica.load(documentSchema, alone.replica.snapshot(), randomActor()))).toBe('# Plan\n\nGoals\n')
  })
})
