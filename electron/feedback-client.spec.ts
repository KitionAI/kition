import { describe, expect, it, vi } from 'vitest'

import { submitFeedbackToConsole } from './feedback-client.mjs'

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('submitFeedbackToConsole', () => {
  it('submits authenticated feedback to the Console issue-report API', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {
      data: { ticketId: 'ticket-123', accepted_at: '2026-08-09T12:00:00Z' },
    }))

    await expect(submitFeedbackToConsole({
      fetchImpl,
      portalBaseURL: 'https://kition.ai',
      request: {
        access_token: 'portal-token',
        contact_email: 'user@example.com',
        description: 'Please add a faster feedback workflow.',
      },
    })).resolves.toEqual({
      ticket_id: 'ticket-123',
      accepted_at: '2026-08-09T12:00:00Z',
    })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://kition.ai/api/issue-reports',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer portal-token' }),
      }),
    )
    const payload = JSON.parse(fetchImpl.mock.calls[0][1].body)
    expect(payload).toMatchObject({
      schema_version: 1,
      description: 'Please add a faster feedback workflow.',
      contactEmail: 'user@example.com',
      via: 'desktop',
    })
  })

  it('retries anonymously when the stored account token is no longer valid', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(401, { error: 'unauthorized' }))
      .mockResolvedValueOnce(jsonResponse(200, { data: { ticketId: 'ticket-anon' } }))

    await expect(submitFeedbackToConsole({
      fetchImpl,
      portalBaseURL: 'https://kition.ai/',
      request: {
        access_token: 'expired-token',
        description: 'The feedback should still be delivered.',
      },
    })).resolves.toMatchObject({ ticket_id: 'ticket-anon' })

    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'https://kition.ai/api/issue-reports',
      'https://kition.ai/api/issue-reports/anonymous',
    ])
    expect(fetchImpl.mock.calls[1][1].headers).not.toHaveProperty('authorization')
  })

  it('rejects invalid feedback before making a network request', async () => {
    const fetchImpl = vi.fn()

    await expect(submitFeedbackToConsole({
      fetchImpl,
      portalBaseURL: 'https://kition.ai',
      request: { description: 'Too short' },
    })).rejects.toThrow('feedback must be 10-500 characters')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
