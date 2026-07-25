import { describe, expect, it, vi } from 'vitest'

import { routeKitableOpenPath } from './workspaceScreenTabRouting'

describe('routeKitableOpenPath', () => {
  it('returns a table-tab payload for a valid table:// sentinel', () => {
    const upsert = vi.fn()
    const result = routeKitableOpenPath(
      'table://Leads.kitable#42',
      {
        tablesByKitablePath: {
          'Leads.kitable': [
            { id: 42, title: 'Leads', order: 10, primaryFieldId: null },
          ],
        },
      },
      upsert,
    )
    expect(result).toBe(true)
    expect(upsert).toHaveBeenCalledWith({
      id: 'kitable:Leads.kitable',
      type: 'table',
      title: 'Leads',
      kitablePath: 'Leads.kitable',
      tableId: 42,
      format: 'data',
    })
  })

  it('uses the kitable filename when the table index has no entry yet', () => {
    const upsert = vi.fn()
    const result = routeKitableOpenPath(
      'table://Leads.kitable#42',
      { tablesByKitablePath: {} },
      upsert,
    )
    expect(result).toBe(true)
    expect(upsert.mock.calls[0][0].title).toBe('Leads')
  })

  it('is a no-op for garbage paths (no upsert, no throw)', () => {
    const upsert = vi.fn()
    expect(routeKitableOpenPath('table://garbage', { tablesByKitablePath: {} }, upsert)).toBe(false)
    expect(routeKitableOpenPath('table://', { tablesByKitablePath: {} }, upsert)).toBe(false)
    expect(upsert).not.toHaveBeenCalled()
  })

  it('returns false for non-table:// paths (caller falls through to the next branch)', () => {
    const upsert = vi.fn()
    expect(routeKitableOpenPath('workflows://X.kitable', { tablesByKitablePath: {} }, upsert)).toBe(false)
    expect(routeKitableOpenPath('note.md', { tablesByKitablePath: {} }, upsert)).toBe(false)
    expect(upsert).not.toHaveBeenCalled()
  })
})
