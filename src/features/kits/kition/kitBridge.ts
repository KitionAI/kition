import type { KitsBridgeChanged, KitsBridgeCommand, KitsBridgeDocument, KitsBridgeDraftInfo, KitsBridgeLiveDocument, KitsBridgeRunStep } from '@/api/kits'
import { runtimeBridge, type BridgeChannel } from '@/services/runtimeBridge'

/**
 * This window's end of the Kit AI bridge (Kition Kit Standard A7 to A10):
 * the runtime asks over one event stream which kit documents are open here
 * and runs the agent's kit tools on them; the open editors answer with their
 * live engines, so the person sees each edit at once and it joins the undo
 * history. The requests arrive on the window's shared bridge stream
 * (`runtimeBridge`), which this channel keeps open while an editor is
 * registered.
 */

/** What a kit editor offers the bridge for its document. */
export type BridgeEditor = {
  path: string
  kitId: string
  revision: () => number
  dirty: () => boolean
  /** The document as the agent sees it (or its draft, with `draft`); an embedded kit UI answers asynchronously. */
  inspect: (options?: DraftOption) => KitsBridgeLiveDocument | Promise<KitsBridgeLiveDocument>
  commands: (query: string) => Promise<KitsBridgeCommand[]>
  run: (steps: Array<{ command: string; params?: Record<string, unknown> }>, save: boolean, options?: DraftOption) => Promise<{ completed: KitsBridgeRunStep[]; saved: boolean }>
  /** A PNG of the whole document (or its draft), at most `maxSize` pixels on its longer side, as base64. */
  preview: (maxSize: number, options?: DraftOption) => Promise<string>
  /**
   * The agent's draft (Kit Standard 2.0 A12), when the kit keeps drafts: the agent may ask for
   * review or take a draft back. Merging and discarding are the person's, never the bridge's.
   */
  draft?: { ready: () => Promise<KitsBridgeDraftInfo>; reopen: () => Promise<KitsBridgeDraftInfo> }
}

/** `draft: true` works on the agent's draft of the document instead of the document. */
type DraftOption = { draft?: boolean }

const editors = new Map<string, BridgeEditor>()
let close: (() => void) | null = null

function normalize(path: string) {
  return path.trim().replace(/^\.\//, '').replace(/^\/+/, '')
}

function editorFor(params: Record<string, unknown> | undefined) {
  const path = normalize(String(params?.path ?? ''))
  const editor = editors.get(path)
  if (!editor) throw new Error(`${path} is not open in a kit editor here`)
  if (params?.kit && params.kit !== editor.kitId) throw new Error(`${path} is open in ${editor.kitId}, not ${String(params.kit)}`)
  return editor
}

async function handle(method: string, params: Record<string, unknown>) {
  switch (method) {
    case 'kit/documents': {
      const documents: KitsBridgeDocument[] = [...editors.values()].map((editor) => ({ path: editor.path, kit: editor.kitId, dirty: editor.dirty(), revision: editor.revision() }))
      return { documents }
    }
    case 'kit/call': {
      const editor = editorFor(params)
      const args = (params.arguments ?? {}) as Record<string, unknown>
      const onDraft: DraftOption = args.draft === true ? { draft: true } : {}
      switch (params.tool) {
        case 'inspect':
          return { document: await editor.inspect(onDraft) }
        case 'commands': {
          const commands = await editor.commands(String(args.query ?? ''))
          return { commands, total: commands.length }
        }
        case 'run': {
          const steps = Array.isArray(args.steps) ? (args.steps as Array<{ command: string; params?: Record<string, unknown> }>) : []
          if (!steps.length) throw new Error('`steps` must be a non-empty array')
          if (onDraft.draft && !editor.draft) throw new Error(`${editor.path} is open in an editor that keeps no drafts; edit it live`)
          const { completed, saved } = await editor.run(steps, !onDraft.draft && args.save !== false, onDraft)
          return { completed, saved, document: await editor.inspect(onDraft) }
        }
        case 'draft_ready':
        case 'draft_reopen': {
          if (!editor.draft) throw new Error(`${editor.path} is open in an editor that keeps no drafts`)
          return params.tool === 'draft_ready' ? editor.draft.ready() : editor.draft.reopen()
        }
        default:
          throw new Error(`unknown kit tool ${String(params.tool)}`)
      }
    }
    case 'kit/preview':
      return { png: await editorFor(params).preview(Math.max(1, Number(params.maxSize) || 1024), params.draft === true ? { draft: true } : {}) }
    default:
      throw new Error(`unknown bridge method ${method}`)
  }
}

const channel: BridgeChannel = { handles: (method) => method.startsWith('kit/'), handle }

/** Makes an open kit editor reachable by the agent; returns the function that withdraws it. */
export function registerBridgeEditor(editor: BridgeEditor) {
  const path = normalize(editor.path)
  editors.set(path, editor)
  close ??= runtimeBridge.open(channel)
  return () => {
    if (editors.get(path) === editor) editors.delete(path)
    if (editors.size) return
    close?.()
    close = null
  }
}

/** Tells the agent a live document changed (A8 `kit.changed`), and who changed it. */
export function reportBridgeChange(change: KitsBridgeChanged) {
  runtimeBridge.notify('kit.changed', { ...change, path: normalize(change.path) })
}
