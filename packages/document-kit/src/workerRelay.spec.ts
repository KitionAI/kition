import { describe, expect, it } from 'vitest'
import { randomActor, Replica, Version } from '@kition/kdm'
import { documentBody, documentRootId, documentSchema, replicaTextSource } from '@kition/document-editor/model'
import { importMarkdownFile } from '@kition/document-editor/file'
import { WorkerRelay, type EngineReplica } from '../web/src/workerRelay'

const ORIGIN = { kind: 'person', principal: 'user:local', label: 'typing' } as const

/** The engine's replica behind the worker interface; `exportChanges` waits for `release()` when held. */
function heldEngine(engine: Replica) {
  let hold: Promise<void> | null = null
  let release = () => {}
  const port: EngineReplica = {
    exportChanges: async (since) => {
      if (hold) await hold
      const changes = engine.exportChanges(Version.decode(new Uint8Array(since)))
      return { changes: changes.slice().buffer as ArrayBuffer, blobs: new ArrayBuffer(0) }
    },
    importChanges: async (changes) => engine.importChanges(new Uint8Array(changes)),
  }
  return {
    port,
    holdNextExport: () => {
      hold = new Promise((resolve) => {
        release = () => {
          hold = null
          resolve()
        }
      })
    },
    release: () => release(),
  }
}

describe('WorkerRelay', () => {
  it('sends the editor an edit made while a pull is waiting for the engine', async () => {
    const engine = importMarkdownFile(new TextEncoder().encode('# Plan\n\nGoals.\n'), randomActor()).replica
    const editor = Replica.load(documentSchema, engine.snapshot(), randomActor())
    const rootId = documentRootId(editor)
    const held = heldEngine(engine)
    const relay = new WorkerRelay(editor, held.port, (error) => {
      throw error
    })
    const source = replicaTextSource(editor, rootId)

    // The engine changes elsewhere (a co-editor), so the editor pulls; the pull waits on the engine.
    replicaTextSource(engine, documentRootId(engine)).replaceText('# Plan\n\nGoals.\n\nNotes.\n', ORIGIN)
    held.holdNextExport()
    relay.pull()
    await Promise.resolve()

    // Meanwhile the person types: the edit is pushed after the pull, as the app does.
    source.replaceText(`${documentBody(editor, rootId)}More.\n`, ORIGIN)
    relay.push()
    held.release()
    await relay.settled()

    expect(documentBody(engine, documentRootId(engine))).toBe(documentBody(editor, rootId))
    expect(documentBody(engine, documentRootId(engine))).toContain('More.')
  })
})
