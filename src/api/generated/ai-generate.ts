/* eslint-disable */
/**
 * GENERATED FILE. Do not edit.
 * Source: contracts/runtime/ai-generate.schema.json
 * Regenerate with: pnpm run contracts:generate
 */

import type { AiChatRuntimeModel } from './ai-chat'

export type AiGeneratePart = {
  type: "text" | "image"
  text?: string
  mime?: string
  /**
   * An image's bytes, base64.
   */
  data?: string
  /**
   * An http(s) image the document names.
   */
  url?: string
}

export type AiGenerateMessage = {
  role: "system" | "user"
  parts: AiGeneratePart[]
}

export type AiGenerateOptions = {
  maxTokens?: number
  temperature?: number
  size?: string
}

export type AiGenerateRequest = {
  purpose: "ai-field"
  output: "text" | "image"
  runtimeModel?: AiChatRuntimeModel
  messages: AiGenerateMessage[]
  options?: AiGenerateOptions
}

export type AiGenerateImage = {
  mime: string
  /**
   * The image's bytes, base64.
   */
  data: string
}

export type AiGenerateUsage = {
  inputTokens?: number
  outputTokens?: number
}

export type AiGenerateAnswer = {
  text?: string
  image?: AiGenerateImage
  model: string
  usage?: AiGenerateUsage
}

export type AiGenerateReason = "unavailable" | "not-allowed" | "quota" | "refused" | "too-large" | "timeout" | "failed"

/**
 * POST /api/v1/ai/generate: the model call behind a kit's host/generate request (Kit UI protocol 2.2 section 7j). The renderer forwards the kit's prompt with the runtime model the person's settings choose; the runtime runs it, logs its usage, and answers text or one image. The kit never sees a key or an endpoint. A refusal carries data.reason: unavailable (no model), not-allowed (a purpose the host does not generate for), quota (no credits left), too-large, timeout, or failed.
 */
export type AiGenerateContract = AiGenerateRequest
