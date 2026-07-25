import request from './request'
import type { AIModel, AIModelForm, AvailableModel, ChatRequest, ChatResponse, ModelCapability } from '@/types'

// List AI models
export function getAIModels(capability?: ModelCapability) {
  return request.get<AIModel[]>('/v1/models', {
    params: capability ? { capability } : {}
  })
}

// List available models (includes OAuth and API Key models)
export function getAvailableModels(sceneType?: string) {
  return request.get<{ models: AvailableModel[] }>('/v1/ai/models/available', {
    params: sceneType ? { scene_type: sceneType } : {}
  })
}

// Unified AI invocation
export function chatWithModel(data: ChatRequest) {
  return request.post<ChatResponse>('/v1/ai/chat', data)
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
