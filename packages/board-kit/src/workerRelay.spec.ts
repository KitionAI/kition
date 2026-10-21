import { describe, expect, it } from 'vitest'
import { randomActor, Version, type Replica } from '@kition/kdm'
import { BoardCommandRegistry } from '@kition/board-editor/lib/boardCommands'
import { BoardStore } from '@kition/board-editor/lib/boardStore'
import { WorkerRelay, type EngineReplica } from '../web/src/workerRelay'

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

const rectangle = (id: string, x: number) => ({ type: 'element.create' as const, elements: [{ id, kind: 'rectangle' as const, x, y: 0, width: 100, height: 80 }] })

describe('WorkerRelay', () => {
  it('sends the engine a commit made while a pull is waiting for the engine', async () => {
    const editor = new BoardStore()
    const engineStore = new BoardStore(editor.getReplica().fork(randomActor()))
    const held = heldEngine(engineStore.getReplica())
    const relay = new WorkerRelay(editor, held.port, (error) => {
      throw error
    })

    // The engine changes elsewhere (a co-editor), so the editor pulls; the pull waits on the engine.
    new BoardCommandRegistry(engineStore).execute(rectangle('from-engine', 0))
    held.holdNextExport()
    relay.pull()
    await Promise.resolve()

    // Meanwhile the person draws: the commit is pushed after the pull, as the app does.
    new BoardCommandRegistry(editor).execute(rectangle('from-editor', 200))
    relay.push()
    held.release()
    await relay.settled()

    expect(engineStore.getReplica().version().includes(editor.getReplica().version())).toBe(true)
  })
})
