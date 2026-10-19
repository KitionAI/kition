/**
 * The Document kit's engine (`kit.document`, engine contract 2 in TypeScript): Kition's Markdown
 * document on the KDM, one text field, behind `@kition/kit-engine`'s `KitModel`. Commands edit the
 * text (positions in UTF-16 code units, as CodeMirror counts them) and its comment threads (Kit
 * Standard 2.0 rule M23), each one transaction. The `.md` file is the text alone: a file opens as
 * a new replica (`import`), or with the replica a host stored for it (`openReplica`), and saves in
 * the line style it was read in.
 */
import type { KitEngineCommand, KitModel } from '@kition/kit-engine'
import { addThread, commentThreads, deleteComment, relocateAnchorRange, reply, setResolved, type CommentAnchor, type ObjectId, type Origin, type Replica } from '@kition/kdm'
import {
  applyTextEdits,
  DOCUMENT_BODY,
  documentBody,
  documentRootId,
  documentSchema,
  diffText,
  exportMarkdownFile,
  importMarkdownFile,
  NEW_FILE_STYLE,
  openStoredMarkdownFile,
  createDocumentReplica,
  analyzeText,
  type LineStyle,
} from '@kition/document-editor/file'

/** The engine's view of a document: its `Document` object, and the line style its file is written in. */
export type DocumentView = { rootId: ObjectId; style: LineStyle }

/** The line style of each replica a file opened as, until its view is made (`load`). */
const fileStyles = new WeakMap<Replica, LineStyle>()

type ParameterSpec = { type: 'string' | 'integer' | 'boolean'; description: string; required?: true }

const offsetParam = (description: string, required?: true): ParameterSpec => ({ type: 'integer', description, ...(required ? { required } : {}) })
const stringParam = (description: string, required?: true): ParameterSpec => ({ type: 'string', description, ...(required ? { required } : {}) })
const AUTHOR = { author: stringParam('The principal the comment is written as (the host\'s person); the one the command runs for by default'), name: stringParam('The author\'s display name') }

/**
 * The document's commands as the engine lists them: `params` is what a person reads, `schema` the
 * parameters as a `ParameterSchemaSpec` (typings, agent tools). Offsets are UTF-16 code units of
 * the Markdown text, as CodeMirror counts them.
 */
const COMMANDS: ReadonlyArray<{ id: string; title: string; params: string; schema: Record<string, ParameterSpec>; mutates?: false }> = [
  { id: 'text.read', title: 'Read the text', params: '{ from?: number, to?: number } (the whole text by default)', schema: { from: offsetParam('Where to start; 0 by default'), to: offsetParam('Where to stop; the end by default') }, mutates: false },
  { id: 'text.insert', title: 'Insert text', params: '{ at: number, text: string }', schema: { at: offsetParam('Where to insert', true), text: stringParam('The Markdown to insert', true) } },
  { id: 'text.delete', title: 'Delete text', params: '{ from: number, to: number }', schema: { from: offsetParam('Where the range starts', true), to: offsetParam('Where it ends', true) } },
  { id: 'text.replace', title: 'Replace text', params: '{ from: number, to: number, text: string }', schema: { from: offsetParam('Where the range starts', true), to: offsetParam('Where it ends', true), text: stringParam('The Markdown to put there', true) } },
  { id: 'document.replace', title: 'Replace the document', params: '{ text: string } (the whole Markdown text; only what differs changes)', schema: { text: stringParam('The whole Markdown text', true) } },
  {
    id: 'comment.add',
    title: 'Comment',
    params: '{ body: string, start?: number, end?: number, quote?: string, author?: string, name?: string } (a range of the text, or the first place `quote` is; the whole document without either)',
    schema: { body: stringParam('The comment', true), start: offsetParam('Where the commented range starts'), end: offsetParam('Where it ends'), quote: stringParam('Text to comment on, where it first is (without start and end)'), ...AUTHOR },
  },
  { id: 'comment.reply', title: 'Reply to a comment', params: '{ thread: string, body: string, author?: string, name?: string }', schema: { thread: stringParam('The thread', true), body: stringParam('The reply', true), ...AUTHOR } },
  { id: 'comment.resolve', title: 'Resolve a comment', params: '{ thread: string, resolved?: boolean } (false opens it again)', schema: { thread: stringParam('The thread', true), resolved: { type: 'boolean', description: 'false opens the thread again; true by default' } } },
  { id: 'comment.delete', title: 'Delete a comment', params: '{ thread: string, comment: string }', schema: { thread: stringParam('The thread', true), comment: stringParam('The comment; deleting a thread\'s last comment deletes the thread', true) } },
  { id: 'comment.threads', title: 'List comments', params: '{} (each thread with its range in the text now)', schema: {}, mutates: false },
]

/** The commands that write only comment threads (kit.json `collaboration.comments.commands`). */
export const COMMENT_COMMANDS = ['comment.add', 'comment.reply', 'comment.resolve', 'comment.delete'] as const

const KNOWN = new Set(COMMANDS.map((command) => command.id))

function integer(params: Record<string, unknown>, key: string, fallback?: number): number {
  const value = params[key] ?? fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error(`${key} is not a text offset: ${JSON.stringify(params[key])}`)
  return value
}

function string(params: Record<string, unknown>, key: string): string {
  const value = params[key]
  if (typeof value !== 'string') throw new Error(`${key} is not a string`)
  return value
}

/** A range of the text, checked against its length. */
function range(params: Record<string, unknown>, length: number, defaults: { from?: number; to?: number } = {}) {
  const from = integer(params, 'from', defaults.from)
  const to = integer(params, 'to', defaults.to)
  if (from > to || to > length) throw new Error(`${from}..${to} is not a range of the text (${length} code units)`)
  return { from, to }
}

/** Replaces `from..to` by `text` in one transaction with `origin`; answers the text's new length. */
function edit(replica: Replica, view: DocumentView, origin: Origin, from: number, to: number, text: string) {
  replica.transact(origin, (tx) => applyTextEdits(tx, view.rootId, DOCUMENT_BODY, [{ from, to, insert: text }]))
  return { length: replica.textLength(view.rootId, DOCUMENT_BODY) }
}

/**
 * Who wrote a comment: the principal the host says the person is (`author`, the Kit UI protocol's
 * `document.comments.me`), else the one the command runs for, and the display name it gives.
 */
function said(origin: Origin, params: Record<string, unknown>, body: string) {
  const author = typeof params.author === 'string' && params.author ? params.author : origin.principal
  const name = typeof params.name === 'string' && params.name ? params.name : undefined
  return { author, ...(name ? { name } : {}), body, created: new Date().toISOString() }
}

/** The anchor of a new thread: a range of the body (given, or where `quote` first is), or the whole document. */
function anchorFor(view: DocumentView, text: string, params: Record<string, unknown>): CommentAnchor {
  const base = { object: view.rootId, field: DOCUMENT_BODY }
  if (params.start !== undefined || params.end !== undefined) {
    const { from, to } = range({ from: params.start, to: params.end }, text.length)
    return { ...base, range: { start: from, end: to }, quote: text.slice(from, to) }
  }
  if (typeof params.quote === 'string' && params.quote) {
    const at = text.indexOf(params.quote)
    if (at < 0) throw new Error(`the text has no ${JSON.stringify(params.quote)}`)
    return { ...base, range: { start: at, end: at + params.quote.length }, quote: params.quote }
  }
  return base
}

function threads(view: DocumentView, replica: Replica) {
  const text = documentBody(replica, view.rootId)
  return commentThreads(replica).map((thread) => ({ ...thread, range: thread.anchor ? relocateAnchorRange(thread.anchor, text) : null }))
}

/** The first heading of `text`, or `null`. */
function firstHeading(text: string) {
  return /^#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(text)?.[1] ?? null
}

export const documentModel: KitModel<DocumentView> = {
  schema: documentSchema,
  load: (replica) => ({ rootId: documentRootId(replica), style: fileStyles.get(replica) ?? NEW_FILE_STYLE }),
  apply(view, replica) {
    // Concurrent creation may have made another `Document` object the one to read.
    view.rootId = documentRootId(replica)
    return { kind: 'full' }
  },
  command(view, replica, id, params, origin) {
    if (!KNOWN.has(id)) throw new Error(`the document has no command ${id}`)
    const text = documentBody(replica, view.rootId)
    switch (id) {
      case 'text.read': {
        const { from, to } = range(params, text.length, { from: 0, to: text.length })
        return { text: text.slice(from, to), length: text.length }
      }
      case 'text.insert': {
        const at = integer(params, 'at')
        if (at > text.length) throw new Error(`${at} is past the end of the text (${text.length} code units)`)
        return edit(replica, view, origin, at, at, string(params, 'text'))
      }
      case 'text.delete': {
        const { from, to } = range(params, text.length)
        return edit(replica, view, origin, from, to, '')
      }
      case 'text.replace': {
        const { from, to } = range(params, text.length)
        return edit(replica, view, origin, from, to, string(params, 'text'))
      }
      case 'document.replace': {
        const target = analyzeText(string(params, 'text')).text
        if (target === text) return { changed: false }
        replica.transact(origin, (tx) => applyTextEdits(tx, view.rootId, DOCUMENT_BODY, diffText(text, target)))
        return { changed: true }
      }
      case 'comment.add': {
        const body = string(params, 'body').trim()
        if (!body) throw new Error('a comment needs a body')
        const anchor = anchorFor(view, text, params)
        return replica.transact(origin, (tx) => addThread(tx, anchor, said(origin, params, body)))
      }
      case 'comment.reply': {
        const body = string(params, 'body').trim()
        if (!body) throw new Error('a reply needs a body')
        const thread = string(params, 'thread') as ObjectId
        return { comment: replica.transact(origin, (tx) => reply(tx, thread, said(origin, params, body))) }
      }
      case 'comment.resolve': {
        const thread = string(params, 'thread') as ObjectId
        const resolved = params.resolved !== false
        replica.transact(origin, (tx) => setResolved(tx, thread, resolved))
        return { resolved }
      }
      case 'comment.delete': {
        const thread = string(params, 'thread') as ObjectId
        const comment = string(params, 'comment') as ObjectId
        replica.transact(origin, (tx) => deleteComment(tx, thread, comment))
        return null
      }
      default:
        return { threads: threads(view, replica) }
    }
  },
  commands(): KitEngineCommand[] {
    return COMMANDS.map((command) => ({
      id: command.id,
      title: command.title,
      menu: null,
      shortcut: null,
      mutates: command.mutates ?? true,
      enabled: true,
      params: command.params,
      ...(Object.keys(command.schema).length ? { schema: command.schema } : {}),
    }))
  },
  import(_name, bytes, actor) {
    const { replica, style } = importMarkdownFile(bytes, actor)
    fileStyles.set(replica, style)
    return replica
  },
  openReplica(_name, bytes, snapshot, _blobs, actor) {
    const { replica, style } = openStoredMarkdownFile(bytes, snapshot, actor)
    fileStyles.set(replica, style)
    return replica
  },
  export: (view, replica) => exportMarkdownFile(replica, view.style, view.rootId),
  create: (_name, _size, actor) => createDocumentReplica('', actor).replica,
  inspect(view, replica) {
    const text = documentBody(replica, view.rootId)
    const all = commentThreads(replica)
    return {
      heading: firstHeading(text),
      characters: text.length,
      lines: text ? text.split('\n').length : 0,
      threads: all.length,
      openThreads: all.filter((thread) => !thread.resolved).length,
    }
  },
}
