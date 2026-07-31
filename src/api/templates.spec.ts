import { beforeEach, describe, expect, it, vi } from 'vitest'

import request from './request'
import { instantiateTemplatePackage } from './templates'

vi.mock('./request', () => ({
  default: {
    post: vi.fn(),
  },
}))

describe('template package API', () => {
  beforeEach(() => vi.clearAllMocks())

  it('instantiates a versioned resource bundle into a workspace path', async () => {
    vi.mocked(request.post).mockResolvedValue({
      template_id: 'leads-landing-page',
      snapshot_version: 1,
      document: { id: 7 },
      default_resource: { source_id: 'leads-page', target_id: 'app-2', kind: 'app', title: 'Leads Landing Page' },
      resources: [],
    } as never)

    await instantiateTemplatePackage('leads-landing-page', {
      workspace_root: '/workspace',
      path: 'Leads Landing Page.kitable',
      include_data: true,
    })

    expect(request.post).toHaveBeenCalledWith(
      '/v1/templates/leads-landing-page/instantiate',
      {
        workspace_root: '/workspace',
        path: 'Leads Landing Page.kitable',
        include_data: true,
      },
    )
  })
})
