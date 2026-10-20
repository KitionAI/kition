/**
 * The Document kit's convergence suite (standard 2.0 section 11, L6): kition-sdk's TypeScript
 * runner (`@kition/convergence`, carried as src/lib/convergence) drives replicas of
 * `MarkdownDocument` through the document's own commands (`text.*`, `document.replace`,
 * `comment.*`) and the contract 2 replica members. The suite types into the Markdown text, whose
 * lines are its paragraphs: a split is a newline typed, a merge a newline deleted. The probe object
 * is the first comment thread (`comment.threads` order): its `resolved` is the register the field
 * scenarios set, a new thread is the object `Create` makes, and deleting its comments deletes it.
 * The ordered collection a person reorders in a Markdown document is its lines (Alt+Up and
 * Alt+Down in the editor), so `Reorder` moves a line, through `document.replace`; a thread's
 * comments are only ever appended.
 *
 * The view check holds what the engine shows to what a fresh replica reads: the same text, the
 * same threads, every thread with a comment, and every comment in a thread.
 *
 * Every scenario the document has steps for passes. `fields`, `undo`, and `undo-reconnect` set two
 * register fields of one object, and the catalogue sets one (`comment.resolve`), so they are
 * skipped and the kit is not L6 until a command sets another field of a thread.
 *
 * `KITION_CONVERGENCE_REPORT=<file>` writes the report for `check-manifest.mjs --convergence`;
 * `KITION_CONVERGENCE_SEEDS` and `KITION_CONVERGENCE_STEPS` make the fuzzed runs heavier.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { kitEngineClass } from '@kition/kit-engine'
import { canonicalText, commentThreads, COMMENT_THREAD_TYPE, COMMENT_TYPE, randomActor, Replica, type CommentThread } from '@kition/kdm'
import { createDocumentReplica, documentBody, documentRootId, documentSchema } from '@kition/document-editor/file'
import { KitEngineAdapter, Net, optionsFromEnv, run, runOne, utf16Index, type EngineDocument, type Rng, type Script } from '../../../../src/lib/convergence'
import { documentModel, type DocumentView } from './documentModel'

/** Actors from a counter that `create` restarts, so a failing seed replays the same run. */
const counters = { actor: 0n }
const nextActor = () => {
  counters.actor += 1n
  return counters.actor
}

const MarkdownDocument = kitEngineClass(documentModel, { actor: nextActor })
const SCHEMA = readFileSync(path.join(__dirname, '../../model/schema.json'), 'utf8')

type Doc = EngineDocument<DocumentView>

/** The document every scenario starts from: a heading and four distinct lines, one of them commented on. */
const STARTING_TEXT = '# Plan\n\nGoals for the quarter\nRisks we know\nOwners and dates\n'

/** Pieces random typing picks from: words, a newline, CJK, an emoji with a skin tone modifier, Markdown. */
const PIECES = ['w', 'word ', '\n', '\n\n', String.fromCodePoint(0x4e2d, 0x6587), String.fromCodePoint(0x1f44d, 0x1f3fd), '**bold**', '- item\n', '## ']

const body = (doc: Doc) => documentBody(doc.session.replica, doc.session.view.rootId)
const codePoints = (text: string) => Array.from(text).length
const threadsOf = (doc: Doc) => commentThreads(doc.session.replica)

/** The probe: the first comment thread, as every replica with the same state lists it. */
const probe = (doc: Doc): CommentThread | null => threadsOf(doc)[0] ?? null

/** The text with lines `a` and `b` (indexes of `text.split('\n')`) swapped, or `null` when they read the same. */
function swapLines(text: string, a: number, b: number): string | null {
  const lines = text.split('\n')
  if (a < 0 || b < 0 || a >= lines.length || b >= lines.length || lines[a] === lines[b]) return null
  ;[lines[a], lines[b]] = [lines[b], lines[a]]
  return lines.join('\n')
}

/** The text's lines, without the empty one after a final newline. */
const linesOf = (text: string) => (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n')

class DocumentKit extends KitEngineAdapter<DocumentView> {
  constructor() {
    super({ name: 'kit.document', schema: SCHEMA, model: documentModel, documentClass: MarkdownDocument, actor: nextActor, fileName: 'Plan.md' })
  }

  create(): Doc {
    counters.actor = 0n
    const doc = this.open(createDocumentReplica(STARTING_TEXT, this.newActor()).replica)
    this.run(doc, 'comment.add', { quote: 'Risks', body: 'Which ones?', name: 'Ada' })
    return doc
  }

  /** Runs one command, as `run` does; exposed for the scenarios of this file. */
  command(doc: Doc, id: string, params: Record<string, unknown>): unknown {
    return this.run(doc, id, params)
  }

  /** Inserts `text` at code point `at` of the body. */
  private insert(doc: Doc, at: number, text: string) {
    this.run(doc, 'text.insert', { at: utf16Index(body(doc), at), text })
  }

  /** Deletes `len` code points at code point `at` of the body. */
  private remove(doc: Doc, at: number, len: number) {
    const text = body(doc)
    this.run(doc, 'text.delete', { from: utf16Index(text, at), to: utf16Index(text, at + len) })
  }

  /** Deletes a thread: its comments, last first; deleting the last one deletes the thread. */
  private deleteThread(doc: Doc, thread: CommentThread) {
    for (const comment of [...thread.comments].reverse()) this.run(doc, 'comment.delete', { thread: thread.id, comment: comment.id })
  }

  override script(doc: Doc, step: Script): boolean {
    switch (step.kind) {
      case 'SetField': {
        // A thread has one register a command sets (`resolved`; its anchor is fixed when it is
        // made), and the `Document` none: the suite's second field has no command.
        if (step.slot !== 0) return false
        const thread = probe(doc)
        // A fuzzed document can lose every thread: the step then opens one, which is an edit too.
        if (!thread) return this.script(doc, { kind: 'Create' })
        this.run(doc, 'comment.resolve', { thread: thread.id, resolved: step.value % 2 === 1 })
        return true
      }
      case 'Create': {
        const text = body(doc)
        const end = Math.min(text.length, utf16Index(text, 6))
        this.run(doc, 'comment.add', { start: 0, end, body: 'New thread' })
        return true
      }
      case 'Delete': {
        const thread = probe(doc)
        if (thread) this.deleteThread(doc, thread)
        return true
      }
      case 'Duplicate': {
        // A copy of the thread: the same range, its first comment.
        const thread = probe(doc)
        const first = thread?.comments[0]
        if (!thread || !first) return true
        const range = thread.anchor?.range
        this.run(doc, 'comment.add', { body: first.body, ...(range && range.end <= body(doc).length ? { start: range.start, end: range.end } : {}) })
        return true
      }
      case 'Reorder': {
        // Replica 0 moves the first line down, replica 1 the last line up: different lines.
        const text = body(doc)
        const count = linesOf(text).length
        const moved = step.which === 0 ? swapLines(text, 0, 1) : swapLines(text, count - 1, count - 2)
        if (moved === null) return true
        this.run(doc, 'document.replace', { text: moved })
        return true
      }
      case 'InsertText':
        this.insert(doc, step.at, step.text)
        return true
      case 'DeleteText':
        this.remove(doc, step.at, step.len)
        return true
      case 'SplitParagraph':
        this.insert(doc, step.at, '\n')
        return true
      case 'MergeParagraph': {
        const text = body(doc)
        if (Array.from(text)[step.at] !== '\n') throw new Error(`no paragraph break at ${step.at} of ${JSON.stringify(text)}`)
        this.remove(doc, step.at, 1)
        return true
      }
      default:
        // No tree (Reparent) and no blob field (InsertBlob): images in Markdown name workspace files.
        return false
    }
  }

  text(doc: Doc): string {
    return body(doc)
  }

  /** One command from the document's catalogue, with random parameters; `null` when it has nothing to act on. */
  randomEdit(doc: Doc, rng: Rng): string | null {
    const text = body(doc)
    const length = codePoints(text)
    const threads = threadsOf(doc)
    const thread = rng.pick(threads)
    const at = rng.below(length + 1)
    const span = Math.min(length - at, rng.below(8))
    switch (rng.below(10)) {
      case 0:
      case 1:
      case 2:
        this.insert(doc, at, rng.pick(PIECES) ?? 'w')
        return 'text.insert'
      case 3: {
        if (span === 0) return null
        this.remove(doc, at, span)
        return 'text.delete'
      }
      case 4: {
        this.run(doc, 'text.replace', { from: utf16Index(text, at), to: utf16Index(text, at + span), text: rng.pick(PIECES) ?? 'w' })
        return 'text.replace'
      }
      case 5: {
        // The whole text as an agent or another program writes it: a line moved, changed, or removed.
        const lines = text.split('\n')
        const line = rng.below(lines.length)
        const kind = rng.below(3)
        let next: string | null
        if (kind === 0) next = swapLines(text, line, Math.min(line + 1, lines.length - 1))
        else if (kind === 1) next = lines.map((value, index) => (index === line ? `${value} (edited)` : value)).join('\n')
        else next = lines.filter((_, index) => index !== line).join('\n')
        if (next === null || next === text) return null
        this.run(doc, 'document.replace', { text: next })
        return 'document.replace'
      }
      case 6: {
        const kind = rng.below(3)
        if (kind === 0) {
          if (span === 0) return null
          this.run(doc, 'comment.add', { start: utf16Index(text, at), end: utf16Index(text, at + span), body: `On ${at}` })
        } else if (kind === 1) {
          const words = text.match(/[A-Za-z]{3,}/g) ?? []
          const quote = rng.pick(words)
          if (!quote) return null
          this.run(doc, 'comment.add', { quote, body: `About ${quote}` })
        } else this.run(doc, 'comment.add', { body: 'On the whole document' })
        return 'comment.add'
      }
      case 7: {
        if (!thread) return null
        this.run(doc, 'comment.reply', { thread: thread.id, body: `Reply ${at}` })
        return 'comment.reply'
      }
      case 8: {
        if (!thread) return null
        this.run(doc, 'comment.resolve', { thread: thread.id, resolved: rng.chance(60) })
        return 'comment.resolve'
      }
      default: {
        const comment = thread ? rng.pick(thread.comments) : undefined
        if (!thread || !comment) return null
        this.run(doc, 'comment.delete', { thread: thread.id, comment: comment.id })
        return 'comment.delete'
      }
    }
  }

  /**
   * The view is what a fresh replica reads: the engine's `Document`, its text, and its threads (each
   * with its range in the text now). Every thread has a comment, and every comment is in a thread.
   */
  checkView(doc: Doc): void {
    const { replica, view } = doc.session
    const fresh = Replica.load(documentSchema, replica.snapshot(), randomActor())
    if (view.rootId !== documentRootId(fresh)) throw new Error(`the view reads Document ${view.rootId}, a fresh replica ${documentRootId(fresh)}`)
    if (body(doc) !== documentBody(fresh)) throw new Error('the view reads another text than a fresh replica')
    const saved = new TextDecoder().decode(documentModel.export(view, replica, 'Plan.md'))
    if (saved !== documentBody(fresh)) throw new Error(`the file saves ${JSON.stringify(saved.slice(0, 80))}, not the replica's text`)
    const listed = this.command(doc, 'comment.threads', {}) as { threads: unknown[] }
    const expected = commentThreads(fresh)
    if (canonicalText(listed.threads.map((thread) => ({ ...(thread as object), range: undefined }))) !== canonicalText(expected.map((thread) => ({ ...thread, range: undefined })))) {
      throw new Error('the engine lists other threads than a fresh replica')
    }
    const objects = (fresh.stateJson() as { objects: Record<string, Record<string, unknown>> }).objects
    const listedComments = new Map<string, string>()
    for (const [id, object] of Object.entries(objects)) {
      if (object.$type !== COMMENT_THREAD_TYPE) continue
      const live = (object.comments as string[]).filter((item) => objects[item]?.$type === COMMENT_TYPE)
      if (live.length === 0) throw new Error(`thread ${id} has no comment`)
      for (const item of live) {
        const other = listedComments.get(item)
        if (other !== undefined) throw new Error(`comment ${item} is in threads ${other} and ${id}`)
        listedComments.set(item, id)
      }
    }
    for (const [id, object] of Object.entries(objects)) {
      if (object.$type === COMMENT_TYPE && !listedComments.has(id)) throw new Error(`comment ${id} is in no thread`)
    }
  }
}

describe('the Document kit converges (standard 2.0 L6)', () => {
  it('passes the convergence suite', () => {
    const report = run(new DocumentKit(), optionsFromEnv(process.env))
    if (process.env.KITION_CONVERGENCE_REPORT) writeFileSync(process.env.KITION_CONVERGENCE_REPORT, report.toJsonText())
    expect(report.passed(), report.render()).toBe(true)
    // The document has no tree and no blob field. A thread's `resolved` is the one register a
    // command sets (an anchor is fixed when the thread is made), so the scenarios that set two
    // fields of one object have no second field: L6 waits for a command that sets another one.
    expect(report.checks.filter((check) => check.outcome.kind !== 'passed').map((check) => check.id)).toEqual(['fields', 'reparent', 'undo', 'undo-reconnect', 'blobs-late'])
    expect(report.level6()).toBe(false)
  }, 300_000)

  it('moves different lines concurrently and keeps each line once', () => {
    const report = runOne(new DocumentKit(), 'reorder', optionsFromEnv(process.env))
    expect(report?.outcome('reorder')).toEqual({ kind: 'passed' })
    const kit = new DocumentKit()
    const net = new Net(kit, 2, 18)
    net.step(0, { kind: 'Reorder', which: 0 })
    net.step(1, { kind: 'Reorder', which: 1 })
    net.settle()
    expect(linesOf(net.text(0)).sort()).toEqual(linesOf(STARTING_TEXT).sort())
    expect(net.text(0)).toBe('\n# Plan\nGoals for the quarter\nOwners and dates\nRisks we know\n')
  })
})
