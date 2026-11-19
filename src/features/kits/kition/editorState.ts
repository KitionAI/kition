/**
 * The document in a kit's `inspect()`, as an agent reads it: without the editor state the kit
 * declares in its manifest (`kit.json` `engine.editorState`, kition-sdk platform rule K23) and
 * without the editing session's bookkeeping at the top. It is what a headless kit's
 * `view.describe` answers (`kition_kit::document_content`), so an agent reads the same document on
 * either path, and what tells whether a document changed (Kit UI protocol `ai/inspect`, section 7d).
 * The person's selection, current part, view or playhead are not the document: the selection
 * reaches an agent through `ai/selection`, and an agent's steps act in an editor state of their own.
 *
 * Pure: the end-to-end specs import it too.
 */

/** Top-level `inspect()` keys that are the editing session's bookkeeping in every kit (`kition_kit::SESSION_KEYS`). */
const SESSION_KEYS: readonly string[] = ['canUndo', 'canRedo', 'dirty', 'revision', 'history', 'redo', 'undo', 'path', 'title']

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

function isObject(value: unknown): value is Record<string, Json> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** `value` without the keys `names`, at any depth (a copy). */
function withoutNames(value: unknown, names: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => withoutNames(item, names))
  if (!isObject(value)) return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => !names.has(key)).map(([key, item]) => [key, withoutNames(item, names)]))
}

/** The value a JSON Pointer's tokens lead to in `root`, or undefined. */
function at(root: unknown, tokens: string[]): unknown {
  let value = root
  for (const token of tokens) {
    if (Array.isArray(value)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) return undefined
      value = value[Number(token)]
    } else if (isObject(value) && Object.hasOwn(value, token)) value = value[token]
    else return undefined
  }
  return value
}

/**
 * `inspected` without the session's bookkeeping at the top and without `editorState`: a name
 * (`selected`) is left out wherever it is, a JSON Pointer (`/view`, `/view/zoom`) only at that
 * place, so a document field of the same name elsewhere (a keyframe's `time`) stays.
 */
export function documentContent(inspected: unknown, editorState: readonly string[]): unknown {
  const pointers = editorState.filter((key) => key.startsWith('/'))
  const value = withoutNames(inspected, new Set(editorState.filter((key) => !key.startsWith('/'))))
  if (!isObject(value)) return value
  for (const key of SESSION_KEYS) delete value[key]
  for (const pointer of pointers) {
    const tokens = pointer
      .slice(1)
      .split('/')
      .map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'))
    const key = tokens.pop()!
    const parent = at(value, tokens)
    if (isObject(parent)) delete parent[key]
  }
  return value
}

/**
 * The editor state a kit's manifest declares (`engine.editorState`), or null for a manifest that
 * declares none, whose `inspect()` is then read whole, as before kits declared it.
 */
export function declaredEditorState(manifest: unknown): string[] | null {
  const declared = isObject(manifest) && isObject(manifest.engine) ? manifest.engine.editorState : undefined
  return Array.isArray(declared) && declared.every((key) => typeof key === 'string') ? (declared as string[]) : null
}

/** What an agent reads of an `ai/inspect` answer: its `details` as the document (`documentContent`), when the kit declares its editor state. */
export function agentInspect<T extends { details?: unknown }>(answer: T, editorState: readonly string[] | null): T {
  if (!editorState || !('details' in answer)) return answer
  return { ...answer, details: documentContent(answer.details, editorState) }
}

/** The editor state the kit in package `dir` declares, from its `kit.json`; null when it declares none or has no manifest. */
export async function kitEditorState(dir: string): Promise<string[] | null> {
  const response = await fetch(`/kits/${dir}/kit.json`, { cache: 'no-store' }).catch(() => null)
  if (!response?.ok) return null
  return declaredEditorState(await response.json().catch(() => null))
}
