import {
  kitBridgeURL,
  postKitBridgeMessage,
  type KitsBridgeChanged,
  type KitsBridgeCommand,
  type KitsBridgeDocument,
  type KitsBridgeLiveDocument,
  type KitsBridgeRunStep,
} from '@/api/kits'

/**
 * This window's end of the Kit AI bridge (Kition Kit Standard A7 to A10):
 * the runtime asks over one event stream which kit documents are open here
 * and runs the agent's kit tools on them; the open editors answer with their
 * live engines, so the person sees each edit at once and it joins the undo
 * history. With no editor registered, the stream is closed.
 */

/** What a kit editor offers the bridge for its document. */
export type BridgeEditor = {
  path: string
  kitId: string
  revision: () => number
  dirty: () => boolean
  /** The document as the agent sees it; an embedded kit UI answers asynchronously. */
  inspect: () => KitsBridgeLiveDocument | Promise<KitsBridgeLiveDocument>
  commands: (query: string) => Promise<KitsBridgeCommand[]>
  run: (steps: Array<{ command: string; params?: Record<string, unknown> }>, save: boolean) => Promise<{ completed: KitsBridgeRunStep[]; saved: boolean }>
  /** A PNG of the whole document, at most `maxSize` pixels on its longer side, as base64. */
  preview: (maxSize: number) => Promise<string>
}

type Request = { jsonrpc: '2.0'; id?: number; method?: string; params?: Record<string, unknown> }

const editors = new Map<string, BridgeEditor>()
let source: EventSource | null = null
let session: number | null = null
// Requests run one after another, in the order the runtime sent them (a run, then its preview).
let queue: Promise<unknown> = Promise.resolve()

function normalize(path: string) {
  return path.trim().replace(/^\.\//, '').replace(/^\/+/, '')
}

function answer(to: number | null, id: number, result: unknown) {
  if (to == null) return
  void postKitBridgeMessage(to, { jsonrpc: '2.0', id, result }).catch(() => undefined)
}

function fail(to: number | null, id: number, message: string) {
  if (to == null) return
  void postKitBridgeMessage(to, { jsonrpc: '2.0', id, error: { code: -32000, message } }).catch(() => undefined)
}

function editorFor(params: Record<string, unknown> | undefined) {
  const path = normalize(String(params?.path ?? ''))
  const editor = editors.get(path)
  if (!editor) throw new Error(`${path} is not open in a kit editor here`)
  if (params?.kit && params.kit !== editor.kitId) throw new Error(`${path} is open in ${editor.kitId}, not ${String(params.kit)}`)
  return editor
}

async function handle(request: Request) {
  const params = request.params ?? {}
  switch (request.method) {
    case 'bridge.ready':
      session = Number(params.session)
      return undefined
    case 'kit/documents': {
      const documents: KitsBridgeDocument[] = [...editors.values()].map((editor) => ({ path: editor.path, kit: editor.kitId, dirty: editor.dirty(), revision: editor.revision() }))
      return { documents }
    }
    case 'kit/call': {
      const editor = editorFor(params)
      const args = (params.arguments ?? {}) as Record<string, unknown>
      switch (params.tool) {
        case 'inspect':
          return { document: await editor.inspect() }
        case 'commands': {
          const commands = await editor.commands(String(args.query ?? ''))
          return { commands, total: commands.length }
        }
        case 'run': {
          const steps = Array.isArray(args.steps) ? (args.steps as Array<{ command: string; params?: Record<string, unknown> }>) : []
          if (!steps.length) throw new Error('`steps` must be a non-empty array')
          const { completed, saved } = await editor.run(steps, args.save !== false)
          return { completed, saved, document: await editor.inspect() }
        }
        default:
          throw new Error(`unknown kit tool ${String(params.tool)}`)
      }
    }
    case 'kit/preview':
      return { png: await editorFor(params).preview(Math.max(1, Number(params.maxSize) || 1024)) }
    default:
      throw new Error(`unknown bridge method ${String(request.method)}`)
  }
}

function connect() {
  if (source || typeof EventSource === 'undefined') return
  source = new EventSource(kitBridgeURL())
  source.onmessage = (event) => {
    let request: Request
    try {
      request = JSON.parse(event.data) as Request
    } catch {
      return
    }
    // An answer goes to the session its request came on, even if the stream has reconnected since.
    let replyTo: number | null = null
    queue = queue
      .then(() => {
        replyTo = session
        return handle(request)
      })
      .then(
        (result) => {
          if (request.id != null) answer(replyTo, request.id, result ?? {})
        },
        (error: unknown) => {
          if (request.id != null) fail(replyTo, request.id, error instanceof Error ? error.message : String(error))
        },
      )
  }
  // The browser reconnects on its own; the new stream announces its session first.
}

function disconnect() {
  source?.close()
  source = null
  session = null
}

/** Makes an open kit editor reachable by the agent; returns the function that withdraws it. */
export function registerBridgeEditor(editor: BridgeEditor) {
  const path = normalize(editor.path)
  editors.set(path, editor)
  connect()
  return () => {
    if (editors.get(path) === editor) editors.delete(path)
    if (!editors.size) disconnect()
  }
}

/** Tells the agent a live document changed (A8 `kit.changed`), and who changed it. */
export function reportBridgeChange(change: KitsBridgeChanged) {
  if (session == null) return
  void postKitBridgeMessage(session, { jsonrpc: '2.0', method: 'kit.changed', params: { ...change, path: normalize(change.path) } }).catch(() => undefined)
}
