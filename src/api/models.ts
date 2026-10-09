import request from './request'
import type { AIModel, AIModelForm, ChatRequest, ChatResponse, ModelCapability } from '@/types'

// List AI models
export function getAIModels(capability?: ModelCapability) {
  return request.get<AIModel[]>('/v1/models', {
    params: capability ? { capability } : {}
  })
}

/**
 * One-shot, non-streaming completion. Pass `signal` to cancel; a cancelled
 * call rejects, so callers should check `signal.aborted` before reporting.
 * Errors are left to the caller rather than logged as request failures.
 */
export function chatWithModel(data: ChatRequest, options: { signal?: AbortSignal } = {}) {
  return request.post<ChatResponse>('/v1/ai/chat', data, {
    signal: options.signal,
    suppressErrorMessage: true,
  })
}

// Create AI model
export function addAIModel(data: AIModelForm) {
  return request.post<AIModel>('/v1/models', data)
}

// Update AI model
export function updateAIModel(id: number, data: Partial<AIModelForm>) {
  return request.put<AIModel>(`/v1/models/${id}`, data)
}

// Delete AI model
export function deleteAIModel(id: number) {
  return request.delete(`/v1/models/${id}`)
}
