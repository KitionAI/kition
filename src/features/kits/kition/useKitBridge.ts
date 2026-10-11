import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { notify } from '@/lib/notify'
import type { KitsBridgeCommand, KitsBridgeLiveDocument, KitsBridgeRunStep } from '@/api/kits'
import type { KitEngine } from '../sdk/kitEngine'
import type { KitCommand } from '../sdk/kitSdk'
import type { useKitDocument } from '../sdk/useKitDocument'
import { registerBridgeEditor, reportBridgeChange } from './kitBridge'

type KitDocument = ReturnType<typeof useKitDocument<unknown>>

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function live(engine: KitEngine, path: string): KitsBridgeLiveDocument {
  const { width, height, dirty, canUndo, canRedo, inspected } = engine.info
  return { path, summary: `${width} × ${height}${dirty ? ', unsaved' : ''}`, dirty, canUndo, canRedo, details: inspected }
}

/** Commands whose id, title, or parameter notes hold every keyword, as the runtime matches them. */
function matching(commands: readonly KitCommand[], query: string): KitsBridgeCommand[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  return commands
    .filter((command) => {
      const haystack = `${command.id} ${command.title} ${command.description ?? ''} ${command.params ?? ''}`.toLowerCase()
      return terms.every((term) => haystack.includes(term))
    })
    .map((command) => ({
      id: command.id,
      title: command.title,
      description: command.params ? `Params: ${command.params}` : command.description,
      enabled: command.enabled,
      mutates: command.mutates,
    }))
}

/** The whole document as a PNG, at most `maxSize` pixels on its longer side, as base64. */
async function previewPng(engine: KitEngine, maxSize: number) {
  const scale = Math.min(1, maxSize / Math.max(1, engine.width, engine.height))
  const width = Math.max(1, Math.round(engine.width * scale))
  const height = Math.max(1, Math.round(engine.height * scale))
  const rgba = await engine.render(0, 0, scale, width, height)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  canvas.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, rgba.byteLength), width, height), 0, 0)
  return canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '')
}

/**
 * Offers an open kit document to the agent through the Kit AI bridge: its
 * tools run on this editor's live engine, so edits repaint here and join the
 * undo history. Agent edits are marked until the person edits again.
 */
export function useKitBridge(document: KitDocument) {
  const { t } = useTranslation('workspace')
  const latest = useRef(document)
  latest.current = document
  const agentRevision = useRef<number | null>(null)
  // While the agent's steps run, their repaints are the agent's, not the person's.
  const agentRunning = useRef(false)
  const [agentEdited, setAgentEdited] = useState(false)
  const { doc, path, manifest, change } = document

  useEffect(() => {
    if (!doc) return undefined
    const name = path.split('/').filter(Boolean).pop() || path
    return registerBridgeEditor({
      path,
      kitId: manifest.kitId,
      revision: () => doc.info.revision,
      dirty: () => doc.info.dirty,
      inspect: () => live(doc, path),
      commands: async (query) => matching(await doc.commands(), query),
      run: async (steps, save) => {
        const completed: KitsBridgeRunStep[] = []
        agentRunning.current = true
        try {
          for (const [index, step] of steps.entries()) {
            const before = doc.info.revision
            let result: string | null
            try {
              result = await latest.current.run(step.command, step.params ?? {})
            } catch (error) {
              throw new Error(`step ${index} (\`${step.command}\`) failed: ${errorText(error)}`)
            }
            let parsed: unknown = result
            try {
              parsed = result == null ? null : JSON.parse(result)
            } catch {
              // A plain string result stays a string.
            }
            completed.push({ command: step.command, changed: doc.info.revision !== before, result: parsed })
          }
        } finally {
          agentRunning.current = false
        }
        if (completed.some((step) => step.changed)) {
          agentRevision.current = doc.info.revision
          setAgentEdited(true)
          reportBridgeChange({ path, revision: doc.info.revision, by: 'agent' })
          notify.info(t('kitEditor.agentEditedNotice', { name }))
        }
        if (save && doc.info.dirty) await latest.current.save()
        return { completed, saved: save && !doc.info.dirty }
      },
      preview: (maxSize) => previewPng(doc, maxSize),
    })
  }, [doc, manifest.kitId, path, t])

  // A change the agent did not make is the person's: it ends the agent mark, and the agent hears of it.
  useEffect(() => {
    if (!doc || !change.revision || agentRunning.current) return
    const revision = doc.info.revision
    if (agentRevision.current === revision) return
    if (agentRevision.current != null && revision !== agentRevision.current) {
      agentRevision.current = null
      setAgentEdited(false)
    }
    reportBridgeChange({ path, revision, by: 'person' })
  }, [change.revision, doc, path])

  return { agentEdited }
}
