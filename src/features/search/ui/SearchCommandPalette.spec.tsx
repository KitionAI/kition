import { describe, it, expect, vi } from 'vitest'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { SearchCommandPalette } from './SearchCommandPalette'
import type { SearchService } from '../service/searchService'
import type { SearchHit } from '../types'

const mkHit = (id: string): SearchHit => ({
  id, score: 1, matches: [],
  doc: { id, kind: 'note', vaultPath: 'a.md', title: 'a', body: id, tags: [], anchor: { kind: 'note', line: 1, ch: 0 } } as any,
})

describe('SearchCommandPalette', () => {
  it('Enter calls onPick with cursor hit', async () => {
    const svc = { query: vi.fn().mockResolvedValue([mkHit('1'), mkHit('2'), mkHit('3')]) } as unknown as SearchService
    const onPick = vi.fn()
    const onClose = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<SearchCommandPalette service={svc} ready open onClose={onClose} onPick={onPick} />)
    })
    const input = container.querySelector('input')!
    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      nativeSetter?.call(input, 'x')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(r => setTimeout(r, 300))
    })
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
    })
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    })
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: '2' }))
    expect(onClose).toHaveBeenCalled()
    await act(async () => root.unmount())
    document.body.removeChild(container)
  })

  it('Cmd+2 quick-selects the second result', async () => {
    const svc = { query: vi.fn().mockResolvedValue([mkHit('1'), mkHit('2'), mkHit('3')]) } as unknown as SearchService
    const onPick = vi.fn()
    const onClose = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<SearchCommandPalette service={svc} ready open onClose={onClose} onPick={onPick} />)
    })
    const input = container.querySelector('input')!
    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      nativeSetter?.call(input, 'x')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(r => setTimeout(r, 300))
    })
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', metaKey: true }))
    })
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: '2' }))
    expect(onClose).toHaveBeenCalled()
    await act(async () => root.unmount())
    document.body.removeChild(container)
  })

  it('disables querying until the index is ready', async () => {
    const svc = { query: vi.fn() } as unknown as SearchService
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <SearchCommandPalette
          service={svc}
          ready={false}
          open
          onClose={() => undefined}
          onPick={() => undefined}
        />,
      )
    })

    expect((container.querySelector('input') as HTMLInputElement).disabled).toBe(true)
    expect(svc.query).not.toHaveBeenCalled()
    await act(async () => root.unmount())
    document.body.removeChild(container)
  })
})
