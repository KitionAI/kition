import { describe, expect, it } from 'vitest'

import type { DataTable } from '@/types/dataDocument'

import { buildInitialFormFields, uniqueFieldKey } from './formBuilder'

describe('form builder', () => {
  it('creates editable form fields from compatible table fields', () => {
    const table = {
      fields: [
        { id: 1, title: 'Contact email', name: 'contact_email', type: 'text', required: true, readonly: false },
        { id: 2, title: 'Guests', name: 'guests', type: 'number', required: false, readonly: false },
        { id: 3, title: 'Room', name: 'room', type: 'single_select', required: false, readonly: false, options: { choices: ['Salon', 'Terrace'] } },
        { id: 4, title: 'Created at', name: 'created_at', type: 'created_time', required: false, readonly: true },
      ],
    } as unknown as DataTable

    expect(buildInitialFormFields(table)).toEqual([
      expect.objectContaining({ key: 'contact_email', type: 'email', required: true, targetFieldTitle: 'Contact email' }),
      expect.objectContaining({ key: 'guests', type: 'number', targetFieldTitle: 'Guests' }),
      expect.objectContaining({ key: 'room', type: 'select', options: ['Salon', 'Terrace'], targetFieldTitle: 'Room' }),
    ])
  })

  it('generates stable unique field keys', () => {
    expect(uniqueFieldKey('2nd guest name', new Set(['field_2nd_guest_name']))).toBe('field_2nd_guest_name_2')
  })
})
