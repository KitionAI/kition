/** Types the table editor shares with its host. */

/** A runtime timestamp: Unix milliseconds (protocol 2) or an older ISO string. */
export type ApiTimestamp = string | number

// AI model
// 'image' = image generation. 'vision' = image input (multimodal).
// They're distinct: a model can have one without the other (gpt-image-1 does
// generation only; older gpt-4-turbo did vision input but not generation).
export type ModelCapability = 'text' | 'image' | 'vision' | 'video' | 'audio'

/** The model an AI run writes with. */
export interface RuntimeWritingModel {
  provider_type: 'openai' | 'anthropic' | 'deepseek' | 'kimi' | 'custom' | 'kition_console'
  provider_label: string
  model_name: string
  base_url: string
  api_key: string
  access_token?: string
  auth_header?: string
  auth_scheme?: 'bearer' | 'raw' | 'x-api-key'
  wire_api?: 'responses' | 'chat_completions' | 'anthropic_messages'
  reasoning_effort?: 'minimal' | 'low' | 'medium' | 'high'
  hosted_web_search_version?: '20260209' | '20250305'
  disable_response_storage?: boolean
}
