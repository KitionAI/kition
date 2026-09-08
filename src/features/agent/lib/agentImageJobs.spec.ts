import { describe, expect, it } from 'vitest'
import type { AgentMessage } from '@/api/agent'
import { buildAgentImageJobs, imageEventsForTurn, type AgentImageSessionEvent } from './agentImageJobs'
const event: AgentImageSessionEvent = {
  type: 'image_generation.event', schema_version: 1, request_id: 'request-1', event: 'image_generation.completed', status: 'completed',
}
describe('image result jobs', () => {
  it('keeps terminal status when late progress arrives and deduplicates artifacts', () => {
    const artifactEvent: AgentImageSessionEvent = {
      ...event, event: 'image_generation.artifact', status: 'saving', artifact: {
        id: 3, path: 'Agent/image.png', mime_type: 'image/png', created_at: '2026-09-05T00:00:00Z',
        variant_index: 0, variant_count: 1, provenance: { request_id: 'request-1' },
      },
    }
    const jobs = buildAgentImageJobs([event, artifactEvent, artifactEvent, { ...event, status: 'generating', event: 'image_generation.progress', progress: 0.5 }])
    expect(jobs[0].latest.status).toBe('completed')
    expect(jobs[0].artifacts).toHaveLength(1)
  })
  it('keeps failed requests on their original turn after a new user message', () => {
    const events = [{ ...event, status: 'failed' as const, clientMessageId: 12 }]
    expect(imageEventsForTurn(events, { id: 12 } as AgentMessage, null, false)).toHaveLength(1)
    expect(imageEventsForTurn(events, { id: 13 } as AgentMessage, null, true)).toHaveLength(0)
  })
})
