import { describe, expect, it } from 'vitest'

import type { BodyTemplate, TableSchema } from '@/features/workflow/components/BodyTemplateEditor.types'
import { findDanglingFieldRefs, pruneBody } from '@/features/workflow/lib/workflowDraft'

const SCHEMA: TableSchema = {
  id: 't_leads',
  name: 'Leads',
  fields: [
    { id: 'f_name', name: 'Name', type: 'text' },
    { id: 'f_email', name: 'Email', type: 'text' },
  ],
}

describe('findDanglingFieldRefs', () => {
  it('returns empty list when every field_ref resolves on the schema', () => {
    const body: BodyTemplate = {
      parts: [
        { kind: 'text', text: 'Hi ' },
        { kind: 'field_ref', fieldRef: { nodeId: 'trigger_1', fieldId: 'f_name' } },
      ],
    }
    expect(findDanglingFieldRefs(body, SCHEMA)).toEqual([])
  })

  it('returns the unresolved field IDs in order', () => {
    const body: BodyTemplate = {
      parts: [
        { kind: 'text', text: 'Hello ' },
        { kind: 'field_ref', fieldRef: { nodeId: 'trigger_1', fieldId: 'f_name' } },
        { kind: 'text', text: ' from ' },
        { kind: 'field_ref', fieldRef: { nodeId: 'trigger_1', fieldId: 'f_ghost' } },
        { kind: 'newline' },
        { kind: 'field_ref', fieldRef: { nodeId: 'trigger_1', fieldId: 'f_another_ghost' } },
      ],
    }
    expect(findDanglingFieldRefs(body, SCHEMA)).toEqual(['f_ghost', 'f_another_ghost'])
  })

  it('treats an empty body as having no dangling refs', () => {
    expect(findDanglingFieldRefs({ parts: [] }, SCHEMA)).toEqual([])
  })
})

describe('pruneBody', () => {
  it('drops only the listed field_refs and preserves the rest in order', () => {
    const body: BodyTemplate = {
      parts: [
        { kind: 'text', text: 'Hi ' },
        { kind: 'field_ref', fieldRef: { nodeId: 'trigger_1', fieldId: 'f_name' } },
        { kind: 'text', text: ', your order ' },
        { kind: 'field_ref', fieldRef: { nodeId: 'trigger_1', fieldId: 'f_ghost' } },
        { kind: 'newline' },
        { kind: 'text', text: 'has shipped.' },
      ],
    }
    const next = pruneBody(body, ['f_ghost'])
    expect(next.parts).toEqual([
      { kind: 'text', text: 'Hi ' },
      { kind: 'field_ref', fieldRef: { nodeId: 'trigger_1', fieldId: 'f_name' } },
      { kind: 'text', text: ', your order ' },
      { kind: 'newline' },
      { kind: 'text', text: 'has shipped.' },
    ])
  })

  it('returns a structural copy — does not mutate the input field_ref', () => {
    const body: BodyTemplate = {
      parts: [
        { kind: 'field_ref', fieldRef: { nodeId: 'trigger_1', fieldId: 'f_name' } },
      ],
    }
    const next = pruneBody(body, [])
    expect(next.parts[0]).not.toBe(body.parts[0])
    // The fieldRef object is also cloned so mutating one doesn't bleed to
    // the other — patchWorkflow consumers rely on this isolation.
    const nextFR = next.parts[0].kind === 'field_ref' ? next.parts[0].fieldRef : null
    const srcFR = body.parts[0].kind === 'field_ref' ? body.parts[0].fieldRef : null
    expect(nextFR).not.toBe(srcFR)
  })

  it('no-ops when removeFieldIds is empty', () => {
    const body: BodyTemplate = {
      parts: [
        { kind: 'text', text: 'just text' },
      ],
    }
    expect(pruneBody(body, []).parts).toEqual([{ kind: 'text', text: 'just text' }])
  })
})
