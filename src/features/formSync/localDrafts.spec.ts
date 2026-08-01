import { describe, expect, it } from 'vitest'

import type { FormSyncWorkflow } from './api'
import {
  FORM_SYNC_WORKFLOWS_META_KEY,
  readLocalFormSyncWorkflows,
  removeLocalFormSyncWorkflow,
  writeLocalFormSyncWorkflow,
} from './localDrafts'

const draft = {
  id: 'formsync_local_1',
  name: 'Event form',
  template_id: 'event-form',
  remote_source_id: '',
  public_url: '',
  published: false,
  fields: [],
  target: { document_id: '7', table_id: '11', field_mappings: [] },
  schedule: { enabled: true, interval_minutes: 5 },
  status: 'paused',
  synced_submissions: 0,
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
} satisfies FormSyncWorkflow

describe('local form sync drafts', () => {
  it('preserves unrelated metadata when adding and replacing a draft', () => {
    const added = writeLocalFormSyncWorkflow({ dashboards: [{ id: 'sales' }] }, draft)
    const replaced = writeLocalFormSyncWorkflow(added, { ...draft, name: 'Updated form' })

    expect(replaced.dashboards).toEqual([{ id: 'sales' }])
    expect(readLocalFormSyncWorkflows(replaced)).toEqual([{ ...draft, name: 'Updated form' }])
  })

  it('removes only the requested draft', () => {
    const other = { ...draft, id: 'formsync_local_2' }
    const meta = {
      [FORM_SYNC_WORKFLOWS_META_KEY]: [draft, other],
      dashboards: [],
    }

    expect(readLocalFormSyncWorkflows(removeLocalFormSyncWorkflow(meta, draft.id))).toEqual([other])
  })
})
