/* eslint-disable */
/**
 * GENERATED FILE. Do not edit.
 * Source: contracts/runtime/ai-chat.schema.json
 * Regenerate with: pnpm run contracts:generate
 */

export type AiChatMessage = {
  role: "system" | "user" | "assistant"
  content: string
}

export type AiChatRuntimeModel = {
  provider_type: "openai" | "anthropic" | "deepseek" | "kimi" | "custom" | "kition_console"
  provider_label: string
  model_name: string
  base_url: string
  api_key: string
  access_token?: string
  auth_header?: string
  auth_scheme?: "bearer" | "raw" | "x-api-key"
  wire_api?: "responses" | "anthropic_messages"
  reasoning_effort?: "minimal" | "low" | "medium" | "high"
  hosted_web_search_version?: "20260209" | "20250305"
  disable_response_storage?: boolean
  max_output_tokens?: number
}

export type AiChatRequest = {
  model_id?: string
  scene_type?: string
  messages: AiChatMessage[]
  runtime_model?: AiChatRuntimeModel
}

export type AiChatUsage = {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

export type AiChatResponse = {
  content: string
  model?: string
  usage?: AiChatUsage
}

/**
 * Non-streaming completion used by single-purpose editor actions such as selection translation. Requires AI login for hosted models.
 */
export type AiChatContract = AiChatRequest
