/**
 * Host generation for kits (Kit UI protocol 2.2 section 7j): the model call behind a kit's
 * `host/generate`, run by the runtime with the runtime model the person's settings choose.
 */
import request, { type RequestError } from './request'
import type { AiGenerateAnswer, AiGenerateReason, AiGenerateRequest } from './generated/ai-generate'

export type { AiGenerateAnswer, AiGenerateReason, AiGenerateRequest }

const REASONS: readonly AiGenerateReason[] = ['unavailable', 'not-allowed', 'quota', 'refused', 'too-large', 'timeout', 'failed']

/** A refused generation: the protocol reason and the runtime's message. */
export class AiGenerateError extends Error {
  constructor(readonly reason: AiGenerateReason, message: string) {
    super(message)
  }
}

function refusal(error: unknown): AiGenerateError {
  const failed = error as Partial<RequestError> & { name?: string }
  if (failed?.name === 'TimeoutError' || (error instanceof DOMException && error.name === 'TimeoutError')) return new AiGenerateError('timeout', 'The model took too long to answer.')
  const body = failed?.response?.data as { message?: unknown; data?: { reason?: unknown } } | undefined
  const reason = REASONS.find((known) => known === body?.data?.reason) ?? 'failed'
  const message = typeof body?.message === 'string' && body.message ? body.message : error instanceof Error ? error.message : 'Generation failed.'
  return new AiGenerateError(reason, message)
}

export async function generateForKit(body: AiGenerateRequest, signal?: AbortSignal): Promise<AiGenerateAnswer> {
  try {
    return await request.post<AiGenerateAnswer>('/v1/ai/generate', body, { signal, timeout: 5 * 60_000, suppressErrorMessage: true })
  } catch (error) {
    throw refusal(error)
  }
}
