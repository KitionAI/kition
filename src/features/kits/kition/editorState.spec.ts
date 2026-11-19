import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentInspect, declaredEditorState, documentContent, kitEditorState } from './editorState'

const layer = {
  id: 'layer:1',
  animated: [{ path: 'transform/opacity', keyframes: [{ time: 0.5, value: 0 }, { time: 1.5, value: 1 }] }],
  guide: { selection: 'inside', history: 3 },
  selected: true,
}
const inspected = { canUndo: true, canRedo: false, dirty: true, revision: 4, path: 'a.track', title: 'a', time: 2.5, playhead: 2.5, selection: ['layer:1'], layers: [layer] }

describe('documentContent', () => {
  it('leaves out only the session bookkeeping at the top when the kit declares no editor state', () => {
    expect(documentContent(inspected, [])).toEqual({ time: 2.5, playhead: 2.5, selection: ['layer:1'], layers: [layer] })
  })

  // The same document as kition-headless's inspect_details_keep_document_fields_named_like_editor_state.
  it('leaves out a declared name wherever it is and a declared pointer only at its place', () => {
    const content = documentContent(inspected, ['/time', 'playhead', 'selection', 'selected']) as Record<string, any>
    expect(content).toEqual({
      layers: [{ id: 'layer:1', animated: layer.animated, guide: { history: 3 } }],
    })
    expect(content.layers[0].animated[0].keyframes[1].time).toBe(1.5)
    expect(content.layers[0].guide.history).toBe(3)
  })

  it('follows a pointer into objects and arrays, with ~1 and ~0 escapes, and ignores one that leads nowhere', () => {
    const value = { view: { zoom: 2, center: [0, 0] }, sheets: [{ active: true, cells: 3 }], 'a/b': 1, 'c~d': 2, keep: 1 }
    expect(documentContent(value, ['/view/zoom', '/sheets/0/active', '/a~1b', '/c~0d', '/missing/key', '/sheets/x/cells', '/keep/deeper'])).toEqual({
      view: { center: [0, 0] },
      sheets: [{ cells: 3 }],
      keep: 1,
    })
  })

  it('removes a whole declared subtree (the cad view that follows the canvas)', () => {
    const before = { view: { height: 378.36, width: 640 }, layers: ['0'] }
    const after = { view: { height: 372.31, width: 640 }, layers: ['0'] }
    expect(documentContent(after, ['/view'])).toEqual(documentContent(before, ['/view']))
    expect(documentContent(after, [])).not.toEqual(documentContent(before, []))
  })

  it('never changes what it was given', () => {
    const copy = structuredClone(inspected)
    documentContent(inspected, ['/time', 'selected'])
    expect(inspected).toEqual(copy)
  })
})

describe('declaredEditorState', () => {
  it('reads engine.editorState, and nothing from a manifest that declares none', () => {
    expect(declaredEditorState({ engine: { module: 'm', editorState: ['/view', 'selected'] } })).toEqual(['/view', 'selected'])
    expect(declaredEditorState({ engine: { module: 'm', editorState: [] } })).toEqual([])
    for (const manifest of [{ engine: { module: 'm' } }, {}, null, { engine: { editorState: '/view' } }, { engine: { editorState: [1] } }]) {
      expect(declaredEditorState(manifest)).toBeNull()
    }
  })
})

describe('agentInspect', () => {
  const answer = { path: 'a.track', kit: 'kit.track', revision: 4, summary: '320 × 180', dirty: true, canUndo: true, canRedo: false, details: inspected }

  it('hands the agent the document without the declared editor state', () => {
    expect(agentInspect(answer, ['/time', 'playhead', 'selection', 'selected'])).toEqual({ ...answer, details: { layers: [{ id: 'layer:1', animated: layer.animated, guide: { history: 3 } }] } })
  })

  it('answers as the kit did when its manifest declares no editor state', () => {
    expect(agentInspect(answer, null)).toBe(answer)
  })
})

describe('kitEditorState', () => {
  afterEach(() => vi.unstubAllGlobals())

  it("reads the package's kit.json, and nothing when it is missing or declares none", async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url === '/kits/cad-ui/kit.json') return new Response(JSON.stringify({ engine: { editorState: ['/view'] } }))
      if (url === '/kits/old-ui/kit.json') return new Response(JSON.stringify({ engine: {} }))
      return new Response('', { status: 404 })
    })
    vi.stubGlobal('fetch', fetch)
    expect(await kitEditorState('cad-ui')).toEqual(['/view'])
    expect(await kitEditorState('old-ui')).toBeNull()
    expect(await kitEditorState('gone-ui')).toBeNull()
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))))
    expect(await kitEditorState('cad-ui')).toBeNull()
  })
})
