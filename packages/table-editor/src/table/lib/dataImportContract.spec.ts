import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('data import public contract', () => {
  it('publishes preview, execution, result, and asynchronous job definitions', () => {
    const schema = JSON.parse(readFileSync(resolve('contracts/runtime/data-import.schema.json'), 'utf8'))

    expect(schema.$id).toBe('https://kition.ai/contracts/runtime/data-import.schema.json')
    expect(schema.$defs.preview_request.required).toEqual(['source'])
    expect(schema.$defs.preview_response.required).toContain('fields')
    expect(schema.$defs.execute_request.required).toEqual([
      'import_token',
      'target',
      'write_mode',
      'schema_mode',
    ])
    expect(schema.$defs.job.properties.status.enum).toEqual([
      'queued',
      'running',
      'completed',
      'failed',
      'canceled',
    ])
    expect(schema.$defs.result.required).toContain('rows_created')
  })

  it('requires portable workspace-relative source paths', () => {
    const schema = JSON.parse(readFileSync(resolve('contracts/runtime/data-import.schema.json'), 'utf8'))
    const workspaceSource = schema.$defs.source.oneOf.find((item: any) => item.properties.kind.const === 'workspace')

    expect(workspaceSource.properties.workspace_path.pattern).toContain('(?!/)')
    expect(workspaceSource.properties.workspace_path.pattern).toContain('\\.\\.')
  })
})
