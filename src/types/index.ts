/** A runtime timestamp: Unix milliseconds (protocol 2) or an older ISO string. */
export type ApiTimestamp = string | number

// Common type definitions

export interface ApiResponse<T = any> {
  code: number
  message: string
  data: T
}

export interface PaginationParams {
  page?: number
  page_size?: number
}

export interface PaginationResponse<T> {
  items: T[]
  total: number
  page: number
  page_size: number
  pages: number
}

// Workspace data
export interface User {
  id: number
  username: string
  email: string
  nickname?: string
  phone?: string
  avatar?: string
  is_active: boolean
  role: string
  status?: string
  daily_quota?: number
  used_quota?: number
  total_creations?: number
  last_login_at?: ApiTimestamp | null
  last_login_ip?: string
  created_at: ApiTimestamp
}

// AI model
// 'image' = image generation. 'vision' = image input (multimodal).
// They're distinct: a model can have one without the other (gpt-image-1 does
// generation only; older gpt-4-turbo did vision input but not generation).
export type ModelCapability = 'text' | 'image' | 'vision' | 'video' | 'audio'

export interface AIModel {
  id: number
  user_id: number
  name: string
  provider: string
  model_name: string
  api_key: string
  base_url?: string
  is_default: boolean
  is_active: boolean
  is_system_builtin: boolean
  description?: string
  capabilities: ModelCapability[]
  created_at: ApiTimestamp
  updated_at: ApiTimestamp
  is_readonly?: boolean
}

export interface AIModelForm {
  id?: number
  name: string
  provider: string
  model_name: string
  api_key: string
  base_url?: string
  is_default?: boolean
  is_active?: boolean
  is_system_builtin?: boolean
  description?: string
  capabilities: ModelCapability[]
}

// Creation
export interface RuntimeWritingModel {
  provider_type: 'openai' | 'anthropic' | 'deepseek' | 'kimi' | 'custom' | 'kition_console'
  provider_label: string
  model_name: string
  base_url: string
  api_key: string
  access_token?: string
  auth_header?: string
  auth_scheme?: 'bearer' | 'raw' | 'x-api-key'
  wire_api?: 'responses' | 'anthropic_messages'
  reasoning_effort?: 'minimal' | 'low' | 'medium' | 'high'
  hosted_web_search_version?: '20260209' | '20250305'
  disable_response_storage?: boolean
}

// Unified AI invocation. Contract: contracts/runtime/ai-chat.schema.json.
export type {
  AiChatMessage as ChatMessage,
  AiChatRequest as ChatRequest,
  AiChatResponse as ChatResponse,
} from '@/api/generated'

// ============================================================================
// Writing tool form types
// ============================================================================

// Form field type
export type FormFieldType = 'input' | 'textarea' | 'select' | 'radio' | 'number' | 'slider' | 'history_select' | 'url_fetch'

// Dropdown option
export interface SelectOption {
  label: string
  value: string | boolean
}

// Slider configuration
export interface SliderConfig {
  min?: number
  max?: number
  step?: number
  marks?: Record<number, string>
}

// Form field definition
export interface FormField {
  name: string
  label: string
  type: FormFieldType
  required: boolean
  placeholder?: string
  options?: SelectOption[]
  defaultValue?: any
  rows?: number
  maxLength?: number
  // slider-specific
  sliderConfig?: SliderConfig
  // history_select-specific
  historyConfig?: {
    contentField: string  // Field to populate when selected
    filterToolTypes?: string[]  // Tool types to filter history by; unset shows all
  }
  // url_fetch-specific
  urlFetchConfig?: {
    contentField: string  // Field to populate after fetch
  }
}

// Tool form configuration
export interface ToolFormConfig {
  toolType: string
  name: string
  description: string
  fields: FormField[]
}

// ============================================================================
// AI provider configuration types
// ============================================================================

// Provider auth type
export type AuthType = 'api_key' | 'dual_key' | 'triple_key' | 'api_key_group'

// Provider configuration (frontend)
export interface ProviderOption {
  value: string
  label: string
  authType: AuthType
  defaultBaseUrl: string
  capabilities: ModelCapability[]
  supportsCustomUrl: boolean
}

// Extends AIModelForm to support multiple auth schemes
export interface AIModelFormExtended extends Omit<AIModelForm, 'api_key'> {
  api_key?: string
  secret_key?: string      // Used by dual_key (Baidu, Tencent)
  app_id?: string          // Used by triple_key (Xunfei)
  api_secret?: string      // Used by triple_key (Xunfei)
  group_id?: string        // Used by api_key_group (MiniMax)
}
