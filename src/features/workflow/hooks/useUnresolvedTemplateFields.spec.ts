import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useUnresolvedTemplateFields } from './useUnresolvedTemplateFields'

function HookSurface({ onResult, selectedId }: {
  onResult: (r: ReturnType<typeof useUnresolvedTemplateFields>) => void
  selectedId: string | null
}) {
  const result = useUnresolvedTemplateFields(selectedId)
  useEffect(() => onResult(result), [result, onResult])
  return null
}

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  window.sessionStorage.clear()
})
afterEach(() => {
  root?.unmount()
  container.remove()
  window.sessionStorage.clear()
})

async function mount(node: ReturnType<typeof createElement>) {
  await act(async () => {
    root = createRoot(container)
    root.render(node)
    await Promise.resolve()
  })
}

describe('useUnresolvedTemplateFields', () => {
  it('returns an empty list when selectedId is null', async () => {
    let captured: ReturnType<typeof useUnresolvedTemplateFields> | null = null
    await mount(createElement(HookSurface, { onResult: (r) => { captured = r }, selectedId: null }))
    expect(captured!.fieldNames).toEqual([])
  })

  it('returns an empty list when no key exists for the selected workflow', async () => {
    let captured: ReturnType<typeof useUnresolvedTemplateFields> | null = null
    await mount(createElement(HookSurface, { onResult: (r) => { captured = r }, selectedId: 'wf_a' }))
    expect(captured!.fieldNames).toEqual([])
  })

  it('drains the sessionStorage key on first read and exposes the field names', async () => {
    window.sessionStorage.setItem(
      'kition:workflow:template-unresolved:wf_a',
      JSON.stringify(['Name', 'Company']),
    )
    let captured: ReturnType<typeof useUnresolvedTemplateFields> | null = null
    await mount(createElement(HookSurface, { onResult: (r) => { captured = r }, selectedId: 'wf_a' }))
    expect(captured!.fieldNames).toEqual(['Name', 'Company'])
    // Drain contract: the key must be gone so a refresh doesn't re-fire
    // the banner.
    expect(window.sessionStorage.getItem('kition:workflow:template-unresolved:wf_a')).toBeNull()
  })

  it('silently ignores malformed JSON rather than blowing up the page', async () => {
    window.sessionStorage.setItem('kition:workflow:template-unresolved:wf_a', 'not-json')
    let captured: ReturnType<typeof useUnresolvedTemplateFields> | null = null
    await mount(createElement(HookSurface, { onResult: (r) => { captured = r }, selectedId: 'wf_a' }))
    expect(captured!.fieldNames).toEqual([])
  })

  it('ignores a non-array payload — a corrupted handoff must not surface a misleading banner', async () => {
    window.sessionStorage.setItem(
      'kition:workflow:template-unresolved:wf_a',
      JSON.stringify({ not: 'an array' }),
    )
    let captured: ReturnType<typeof useUnresolvedTemplateFields> | null = null
    await mount(createElement(HookSurface, { onResult: (r) => { captured = r }, selectedId: 'wf_a' }))
    expect(captured!.fieldNames).toEqual([])
  })

  it('filters out non-string entries from a mixed array', async () => {
    window.sessionStorage.setItem(
      'kition:workflow:template-unresolved:wf_a',
      JSON.stringify(['Name', 42, null, 'Company']),
    )
    let captured: ReturnType<typeof useUnresolvedTemplateFields> | null = null
    await mount(createElement(HookSurface, { onResult: (r) => { captured = r }, selectedId: 'wf_a' }))
    expect(captured!.fieldNames).toEqual(['Name', 'Company'])
  })

  it('switching selectedId re-runs the drain against the new key', async () => {
    window.sessionStorage.setItem('kition:workflow:template-unresolved:wf_a', JSON.stringify(['Email']))
    window.sessionStorage.setItem('kition:workflow:template-unresolved:wf_b', JSON.stringify(['Phone']))
    let captured: ReturnType<typeof useUnresolvedTemplateFields> | null = null
    let currentId: string = 'wf_a'
    await mount(createElement(HookSurface, { onResult: (r) => { captured = r }, selectedId: currentId }))
    expect(captured!.fieldNames).toEqual(['Email'])
    // Switch selection — the effect re-runs and drains the new key.
    await act(async () => {
      currentId = 'wf_b'
      root!.render(createElement(HookSurface, { onResult: (r) => { captured = r }, selectedId: currentId }))
      await Promise.resolve()
    })
    expect(captured!.fieldNames).toEqual(['Phone'])
    expect(window.sessionStorage.getItem('kition:workflow:template-unresolved:wf_b')).toBeNull()
  })

  it('dismiss() clears the list without touching sessionStorage (already drained)', async () => {
    window.sessionStorage.setItem('kition:workflow:template-unresolved:wf_a', JSON.stringify(['Name']))
    let captured: ReturnType<typeof useUnresolvedTemplateFields> | null = null
    await mount(createElement(HookSurface, { onResult: (r) => { captured = r }, selectedId: 'wf_a' }))
    expect(captured!.fieldNames).toEqual(['Name'])
    await act(async () => { captured!.dismiss() })
    expect(captured!.fieldNames).toEqual([])
    // Storage was already drained on first read; dismiss is a pure
    // state reset, not a second storage mutation.
    expect(window.sessionStorage.getItem('kition:workflow:template-unresolved:wf_a')).toBeNull()
  })

  it('selectedId=null after a drain clears the list', async () => {
    window.sessionStorage.setItem('kition:workflow:template-unresolved:wf_a', JSON.stringify(['Name']))
    let captured: ReturnType<typeof useUnresolvedTemplateFields> | null = null
    let currentId: string | null = 'wf_a'
    await mount(createElement(HookSurface, { onResult: (r) => { captured = r }, selectedId: currentId }))
    expect(captured!.fieldNames).toEqual(['Name'])
    await act(async () => {
      currentId = null
      root!.render(createElement(HookSurface, { onResult: (r) => { captured = r }, selectedId: currentId }))
      await Promise.resolve()
    })
    expect(captured!.fieldNames).toEqual([])
  })
})
