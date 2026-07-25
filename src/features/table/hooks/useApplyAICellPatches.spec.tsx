import { act, createElement, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it } from 'vitest'

import type { DataAttachment, DataField, DataRecord } from '@/types/dataDocument'

import { useApplyAICellPatches, type AICellPatch } from './useApplyAICellPatches'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

interface HarnessProps {
  patches?: ReadonlyArray<AICellPatch>
  fields: DataField[]
  initialRecords: DataRecord[]
  onRecords: (records: DataRecord[]) => void
}

/**
 * Renders nothing — its only job is to host the hook so we can drive
 * it through act() and observe `setRecords` from the outside via the
 * `onRecords` callback. `initialRecords` is captured once on mount;
 * subsequent re-renders preserve the in-component state so we can
 * test the highwater mark behaviour with new patches against the
 * already-mutated records.
 */
function Harness({ patches, fields, initialRecords, onRecords }: HarnessProps): ReactNode {
  const [records, setRecords] = useState<DataRecord[]>(initialRecords)
  useApplyAICellPatches({
    patches,
    fields,
    setRecords: (updater) => {
      setRecords((prev) => {
        const next =
          typeof updater === 'function'
            ? (updater as (p: DataRecord[]) => DataRecord[])(prev)
            : updater
        // Notify outside the React state machine so the test can read
        // the latest value synchronously. We only call onRecords when
        // the reference actually changed — the hook returns the same
        // array when nothing applied, and we don't want to count that
        // as a setState event.
        if (next !== prev) onRecords(next)
        return next
      })
    },
  })
  return null
}

const fieldA: DataField = {
  id: 21,
  user_id: 1,
  document_id: 1,
  table_id: 1,
  name: 'summary',
  title: 'Summary',
  type: 'long_text',
  order: 1,
  is_primary: false,
  readonly: true,
  options: null,
  created_at: '',
  updated_at: '',
} as unknown as DataField

const fieldB: DataField = {
  ...fieldA,
  id: 22,
  name: 'category',
  title: 'Category',
} as unknown as DataField

const recordA: DataRecord = {
  id: 11,
  user_id: 1,
  document_id: 1,
  table_id: 1,
  row_key: 'a',
  order: 1,
  values: { other: 'left alone' },
  created_at: '',
  updated_at: '',
}

const recordB: DataRecord = {
  ...recordA,
  id: 12,
  row_key: 'b',
}

describe('useApplyAICellPatches', () => {
  let container: HTMLDivElement
  let root: Root | null = null
  let observed: DataRecord[][] = []

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    observed = []
  })

  async function mountWith(props: HarnessProps) {
    await act(async () => {
      root = createRoot(container)
      root.render(createElement(Harness, props))
    })
  }

  async function rerenderWith(props: HarnessProps) {
    await act(async () => {
      root?.render(createElement(Harness, props))
    })
  }

  async function unmount() {
    await act(async () => {
      root?.unmount()
    })
    root = null
    container.remove()
  }

  it('applies a single patch by translating fieldId → field.name', async () => {
    await mountWith({
      patches: [{ recordId: 11, fieldId: 21, value: 'AI says hi' }],
      fields: [fieldA, fieldB],
      initialRecords: [recordA, recordB],
      onRecords: (next) => observed.push(next),
    })
    expect(observed.length).toBe(1)
    const after = observed[0]
    expect(after[0].values).toEqual({ other: 'left alone', summary: 'AI says hi' })
    expect(after[1].values).toEqual({ other: 'left alone' })
    await unmount()
  })

  it('is idempotent across re-renders with the same patches reference', async () => {
    const patches: AICellPatch[] = [
      { recordId: 11, fieldId: 21, value: 'one' },
    ]
    await mountWith({
      patches,
      fields: [fieldA],
      initialRecords: [recordA],
      onRecords: (next) => observed.push(next),
    })
    expect(observed.length).toBe(1)
    await rerenderWith({
      patches,
      fields: [fieldA],
      initialRecords: [recordA],
      onRecords: (next) => observed.push(next),
    })
    // No new setRecords call — highwater mark prevents replay.
    expect(observed.length).toBe(1)
    await unmount()
  })

  it('applies only the new tail when patches grow', async () => {
    const onRecords = (next: DataRecord[]) => observed.push(next)
    await mountWith({
      patches: [{ recordId: 11, fieldId: 21, value: 'one' }],
      fields: [fieldA, fieldB],
      initialRecords: [recordA],
      onRecords,
    })
    expect(observed.length).toBe(1)
    expect(observed[0][0].values).toMatchObject({ summary: 'one' })

    await rerenderWith({
      patches: [
        { recordId: 11, fieldId: 21, value: 'one' },
        { recordId: 11, fieldId: 22, value: 'two' },
      ],
      fields: [fieldA, fieldB],
      initialRecords: [recordA],
      onRecords,
    })
    expect(observed.length).toBe(2)
    expect(observed[1][0].values).toMatchObject({
      summary: 'one',
      category: 'two',
    })
    await unmount()
  })

  it('silently skips unknown recordId / fieldId', async () => {
    await mountWith({
      patches: [
        { recordId: 999, fieldId: 21, value: 'nope' },
        { recordId: 11, fieldId: 999, value: 'nope2' },
      ],
      fields: [fieldA],
      initialRecords: [recordA],
      onRecords: (next) => observed.push(next),
    })
    // The hook returns the same records reference when no patch
    // matched, so onRecords (which fires only on identity change)
    // stays silent — i.e. no observable mutation.
    expect(observed.length).toBe(0)
    await unmount()
  })

  it('does nothing when patches is empty or undefined', async () => {
    await mountWith({
      patches: [],
      fields: [fieldA],
      initialRecords: [recordA],
      onRecords: (next) => observed.push(next),
    })
    expect(observed.length).toBe(0)
    await rerenderWith({
      patches: undefined,
      fields: [fieldA],
      initialRecords: [recordA],
      onRecords: (next) => observed.push(next),
    })
    expect(observed.length).toBe(0)
    await unmount()
  })

  it('defers application until fields have loaded', async () => {
    const onRecords = (next: DataRecord[]) => observed.push(next)
    const patches: AICellPatch[] = [
      { recordId: 11, fieldId: 21, value: 'deferred' },
    ]
    // Fields not yet loaded.
    await mountWith({
      patches,
      fields: [],
      initialRecords: [recordA],
      onRecords,
    })
    expect(observed.length).toBe(0)
    // Fields arrive — patches now apply.
    await rerenderWith({
      patches,
      fields: [fieldA],
      initialRecords: [recordA],
      onRecords,
    })
    expect(observed.length).toBe(1)
    expect(observed[0][0].values).toMatchObject({ summary: 'deferred' })
    await unmount()
  })

  it('preserves a DataAttachment[] value for an AI image cell', async () => {
    const attachments: DataAttachment[] = [
      { name: 'photo1.png', url: 'https://cdn.example.com/photo1.png', mimeType: 'image/png', sizeBytes: 12345 },
      { name: 'photo2.jpg', url: 'https://cdn.example.com/photo2.jpg', mimeType: 'image/jpeg', sizeBytes: 67890 },
    ]
    await mountWith({
      patches: [{ recordId: 11, fieldId: 21, value: attachments }],
      fields: [fieldA, fieldB],
      initialRecords: [recordA, recordB],
      onRecords: (next) => observed.push(next),
    })
    expect(observed.length).toBe(1)
    const after = observed[0]
    // Deep equality — no mutation, flattening, or shape loss
    expect(after[0].values['summary']).toEqual(attachments)
    // Array shape is preserved (not stringified or flattened)
    expect(Array.isArray(after[0].values['summary'])).toBe(true)
    // Other cells on the same record stay untouched
    expect(after[0].values['other']).toBe('left alone')
    // Other records are untouched
    expect(after[1].values).toEqual({ other: 'left alone' })
    await unmount()
  })

  it('preserves attachment array identity across multiple patches', async () => {
    const attachmentsA: DataAttachment[] = [
      { name: 'img-a.png', url: 'https://cdn.example.com/img-a.png', mimeType: 'image/png', sizeBytes: 111 },
    ]
    const attachmentsB: DataAttachment[] = [
      { name: 'img-b.png', url: 'https://cdn.example.com/img-b.png', mimeType: 'image/png', sizeBytes: 222 },
      { name: 'img-c.gif', url: 'https://cdn.example.com/img-c.gif', mimeType: 'image/gif', sizeBytes: 333 },
    ]
    const onRecords = (next: DataRecord[]) => observed.push(next)
    // First patch: write attachmentsA into fieldA (summary)
    await mountWith({
      patches: [{ recordId: 11, fieldId: 21, value: attachmentsA }],
      fields: [fieldA, fieldB],
      initialRecords: [recordA],
      onRecords,
    })
    expect(observed.length).toBe(1)
    expect(observed[0][0].values['summary']).toEqual(attachmentsA)

    // Second patch: write attachmentsB into fieldB (category) — same record
    await rerenderWith({
      patches: [
        { recordId: 11, fieldId: 21, value: attachmentsA },
        { recordId: 11, fieldId: 22, value: attachmentsB },
      ],
      fields: [fieldA, fieldB],
      initialRecords: [recordA],
      onRecords,
    })
    expect(observed.length).toBe(2)
    const finalValues = observed[1][0].values
    // Both arrays survive intact after the second patch
    expect(finalValues['summary']).toEqual(attachmentsA)
    expect(Array.isArray(finalValues['summary'])).toBe(true)
    expect(finalValues['category']).toEqual(attachmentsB)
    expect(Array.isArray(finalValues['category'])).toBe(true)
    await unmount()
  })
})
