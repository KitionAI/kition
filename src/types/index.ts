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
  last_login_at?: string | null
  last_login_ip?: string
  created_at: string
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
  created_at: string
  updated_at: string
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
  provider_type: 'openai' | 'anthropic' | 'deepseek' | 'custom' | 'kition_console'
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

// Available models (API Key models only)
export interface AvailableModel {
  model_id: string  // ai_model_{model_id}
  model_name: string  // Actual model name
  display_name: string  // Display name
  provider: string  // Provider
  source_type: 'api_key'  // Source type
  source_id: number  // Source ID
  is_free: boolean  // Is free
  is_preferred: boolean  // Is user-preferred
  status: 'active' | 'expired' | 'quota_exceeded'  // Status
  quota_info?: {
    used: number
    total: number
    percentage: number
  }
}

// Unified AI invocation
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatRequest {
  model_id: string
  messages: ChatMessage[]
  scene_type?: string
  stream?: boolean
  temperature?: number
  max_tokens?: number
  top_p?: number
}

export interface ChatResponse {
  content: string
  model: string
  usage: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

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
