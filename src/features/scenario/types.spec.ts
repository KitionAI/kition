import { describe, expect, it } from 'vitest'

import {
  isScenarioBuildEvent,
  parseScenarioBuildEvent,
  type ScenarioBuildEvent,
} from './types'

describe('parseScenarioBuildEvent', () => {
  it('parses base.created', () => {
    const ev = parseScenarioBuildEvent(
      '{"kind":"base.created","baseId":"base_abc","baseName":"Receipt Management"}',
    )
    expect(ev).toEqual({
      kind: 'base.created',
      baseId: 'base_abc',
      baseName: 'Receipt Management',
    })
  })

  it('parses table.created', () => {
    const ev = parseScenarioBuildEvent(
      '{"kind":"table.created","tableId":"tbl_xyz","tableName":"Receipts"}',
    )
    expect(ev).toEqual({
      kind: 'table.created',
      tableId: 'tbl_xyz',
      tableName: 'Receipts',
    })
  })

  it('parses fields.generated for both stages', () => {
    expect(
      parseScenarioBuildEvent(
        '{"kind":"fields.generated","stage":"fields","count":2}',
      ),
    ).toEqual({ kind: 'fields.generated', stage: 'fields', count: 2 })

    expect(
      parseScenarioBuildEvent(
        '{"kind":"fields.generated","stage":"ai-fields","count":5}',
      ),
    ).toEqual({ kind: 'fields.generated', stage: 'ai-fields', count: 5 })
  })

  it('parses records.generated', () => {
    expect(
      parseScenarioBuildEvent('{"kind":"records.generated","count":10}'),
    ).toEqual({ kind: 'records.generated', count: 10 })
  })

  it('parses views.generated', () => {
    expect(
      parseScenarioBuildEvent(
        '{"kind":"views.generated","viewKind":"grid","viewId":"view_1","viewName":"Overall"}',
      ),
    ).toEqual({
      kind: 'views.generated',
      viewKind: 'grid',
      viewId: 'view_1',
      viewName: 'Overall',
    })
  })

  it('parses cell.ai.filled with scalar value', () => {
    expect(
      parseScenarioBuildEvent(
        '{"kind":"cell.ai.filled","recordId":42,"fieldId":7,"value":"STRONG FLOUR"}',
      ),
    ).toEqual({
      kind: 'cell.ai.filled',
      recordId: 42,
      fieldId: 7,
      value: 'STRONG FLOUR',
    })
  })

  it('parses cell.ai.filled with object value', () => {
    const ev = parseScenarioBuildEvent(
      '{"kind":"cell.ai.filled","recordId":1,"fieldId":2,"value":{"amount":12.5,"currency":"CNY"}}',
    )
    expect(ev).toEqual({
      kind: 'cell.ai.filled',
      recordId: 1,
      fieldId: 2,
      value: { amount: 12.5, currency: 'CNY' },
    })
  })

  it('parses cell.ai.filled with null value', () => {
    const ev = parseScenarioBuildEvent(
      '{"kind":"cell.ai.filled","recordId":1,"fieldId":2,"value":null}',
    )
    expect(ev).toEqual({
      kind: 'cell.ai.filled',
      recordId: 1,
      fieldId: 2,
      value: null,
    })
  })

  it('parses error', () => {
    expect(
      parseScenarioBuildEvent(
        '{"kind":"error","code":"ai_failed","message":"vendor extraction failed"}',
      ),
    ).toEqual({
      kind: 'error',
      code: 'ai_failed',
      message: 'vendor extraction failed',
    })
  })

  it('parses done', () => {
    expect(parseScenarioBuildEvent('{"kind":"done"}')).toEqual({ kind: 'done' })
  })

  it('returns null for non-JSON input', () => {
    expect(parseScenarioBuildEvent('not json')).toBeNull()
  })

  it('returns null for JSON missing kind', () => {
    expect(parseScenarioBuildEvent('{"baseId":"x"}')).toBeNull()
  })

  it('returns null for unknown kind', () => {
    expect(parseScenarioBuildEvent('{"kind":"mystery"}')).toBeNull()
  })

  it('returns null when required fields are missing', () => {
    expect(
      parseScenarioBuildEvent('{"kind":"base.created","baseId":"x"}'),
    ).toBeNull()
    expect(
      parseScenarioBuildEvent(
        '{"kind":"views.generated","viewKind":"grid","viewId":"v"}',
      ),
    ).toBeNull()
    expect(
      parseScenarioBuildEvent(
        '{"kind":"fields.generated","stage":"fields"}',
      ),
    ).toBeNull()
    expect(
      parseScenarioBuildEvent(
        '{"kind":"cell.ai.filled","recordId":1,"fieldId":2}',
      ),
    ).toBeNull()
  })

  it('returns null when field types are wrong', () => {
    expect(
      parseScenarioBuildEvent(
        '{"kind":"records.generated","count":"ten"}',
      ),
    ).toBeNull()
    expect(
      parseScenarioBuildEvent(
        '{"kind":"base.created","baseId":1,"baseName":"x"}',
      ),
    ).toBeNull()
  })
})

describe('isScenarioBuildEvent', () => {
  it('accepts well-formed events', () => {
    expect(
      isScenarioBuildEvent({
        kind: 'base.created',
        baseId: 'b',
        baseName: 'B',
      }),
    ).toBe(true)
    expect(isScenarioBuildEvent({ kind: 'done' })).toBe(true)
  })

  it('rejects non-objects and malformed payloads', () => {
    expect(isScenarioBuildEvent(null)).toBe(false)
    expect(isScenarioBuildEvent(undefined)).toBe(false)
    expect(isScenarioBuildEvent(42)).toBe(false)
    expect(isScenarioBuildEvent('done')).toBe(false)
    expect(isScenarioBuildEvent({ kind: 'unknown' })).toBe(false)
    expect(isScenarioBuildEvent({})).toBe(false)
  })
})

// Compile-time check: the discriminated union must narrow exhaustively. If a
// new kind is added without updating ScenarioBuildEvent, the `assertNever`
// call below will fail to type-check and `npx vitest run` will surface the
// tsc error. The runtime branches double as a smoke test.
describe('ScenarioBuildEvent discrimination', () => {
  it('narrows each kind to its specific fields', () => {
    const samples: ScenarioBuildEvent[] = [
      { kind: 'base.created', baseId: 'b', baseName: 'B' },
      { kind: 'table.created', tableId: 't', tableName: 'T' },
      { kind: 'fields.generated', stage: 'fields', count: 1 },
      { kind: 'records.generated', count: 1 },
      { kind: 'views.generated', viewKind: 'grid', viewId: 'v', viewName: 'V' },
      { kind: 'cell.ai.filled', recordId: 1, fieldId: 1, value: 'x' },
      { kind: 'error', code: 'c', message: 'm' },
      { kind: 'done' },
    ]

    const seen = new Set<string>()
    for (const ev of samples) {
      switch (ev.kind) {
        case 'base.created':
          seen.add(ev.baseId)
          break
        case 'table.created':
          seen.add(ev.tableId)
          break
        case 'fields.generated':
          seen.add(`${ev.stage}:${ev.count}`)
          break
        case 'records.generated':
          seen.add(String(ev.count))
          break
        case 'views.generated':
          seen.add(`${ev.viewKind}:${ev.viewId}:${ev.viewName}`)
          break
        case 'cell.ai.filled':
          seen.add(`${ev.recordId}:${ev.fieldId}:${String(ev.value)}`)
          break
        case 'error':
          seen.add(`${ev.code}:${ev.message}`)
          break
        case 'done':
          seen.add('done')
          break
        default:
          // Exhaustiveness check — unreachable.
          assertNever(ev)
      }
    }
    expect(seen.size).toBe(samples.length)
  })
})

function assertNever(value: never): never {
  throw new Error(`unhandled scenario event: ${JSON.stringify(value)}`)
}
