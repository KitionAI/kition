import type { Locale } from '@/i18n/types'

export type DesktopSettingsSection =
  | 'general'
  | 'account'
  | 'models'
  | 'providers'
  | 'connections'
  | 'runtime'
  | 'shortcuts'
  | 'mcp'
  | 'display'
  | 'notifications'
  | 'network'
  | 'hooks'
  | 'developer'
  | 'about'

export type DesktopThemeMode = 'auto' | 'light' | 'dark'

export type DesktopProviderKind = 'openai' | 'anthropic' | 'deepseek' | 'kimi' | 'custom' | 'kition_console'

export type DesktopUiDensity = 'compact' | 'normal' | 'relaxed'
export type DesktopAgentTimelineLineHeight = 'tight' | 'normal' | 'loose'
export type DesktopCodeFontFamily =
  | 'JetBrains Mono'
  | 'Fira Code'
  | 'Menlo'
  | 'Consolas'
  | 'system-ui'

export type DesktopHookEvent =
  | 'session_started'
  | 'task_started'
  | 'task_completed'
  | 'task_failed'
  | 'tool_called'
  | 'user_input_needed'
  | 'on_quit'

export type CustomProviderAuthScheme = 'bearer' | 'raw' | 'x-api-key'
export type CustomProviderWireAPI = 'responses' | 'anthropic_messages'
export type CustomProviderReasoningEffort = 'minimal' | 'low' | 'medium' | 'high'
export type HostedWebSearchVersion = '20260209' | '20250305'

export interface DesktopGeneralSettings {
  theme: DesktopThemeMode
  language: Locale
  restoreWorkspaceOnLaunch: boolean
  confirmBeforeQuit: boolean
  autoCheckUpdates: boolean
  updateBetaChannel: boolean
  shareUsageData: boolean
  debug: boolean
}

export interface DesktopDisplaySettings {
  zoomLevel: number
  density: DesktopUiDensity
  codeFontFamily: DesktopCodeFontFamily
  codeFontSize: number
  reduceMotion: boolean
  agentTimelineLineHeight: DesktopAgentTimelineLineHeight
  /** Show the document formatting toolbar above the editor. Off by default. */
  showDocumentToolbar: boolean
}

export interface DesktopNotificationPolicy {
  systemNotificationsEnabled: boolean
  onTaskCompleted: boolean
  onTaskFailed: boolean
  onUserInputNeeded: boolean
  longRunningThresholdSeconds: number
}

export interface DesktopHook {
  id: string
  name: string
  enabled: boolean
  event: DesktopHookEvent
  command: string
  workdir: string
  timeoutSeconds: number
  matcher?: string
  lastRunAt?: string
  lastExitCode?: number
}

export interface DesktopShortcut {
  id: string
  label: string
  combo: string
  enabled: boolean
  description: string
}

export interface DesktopProviderConfig {
  kind: DesktopProviderKind
  enabled: boolean
  label: string
  baseUrl: string
  apiKey: string
  accessToken: string
  refreshToken: string
  modelsPath: string
  authHeader: string
  authScheme: CustomProviderAuthScheme
  wireApi: CustomProviderWireAPI
  reasoningEffort: CustomProviderReasoningEffort
  hostedWebSearchVersion: HostedWebSearchVersion
  disableResponseStorage: boolean
  discoveredModels: string[]
  lastSyncedAt: string
}

export interface DesktopModelSettings {
  activeProvider: DesktopProviderKind
  selectedModelByProvider: Partial<Record<DesktopProviderKind, string>>
  preferredDefaultModel: string
  preferredChatModel: string
  preferredWritingModel: string
}

export interface DesktopSettingsState {
  general: DesktopGeneralSettings
  display: DesktopDisplaySettings
  notifications: DesktopNotificationPolicy
  hooks: DesktopHook[]
  shortcuts: DesktopShortcut[]
  providers: Record<DesktopProviderKind, DesktopProviderConfig>
  models: DesktopModelSettings
}

export interface DesktopProviderDescriptor {
  kind: DesktopProviderKind
  label: string         // short display name, e.g. 'OpenAI'
  sublabel: string      // short qualifier shown next to label, e.g. 'GPT · Codex'
  descriptor: string    // one-line subtitle for the provider editor header, e.g. 'OpenAI · GPT models'
  description: string
  badge: string
  defaultBaseUrl: string
  defaultModelsPath: string
  authLabel: string
}

export interface DiscoverProviderModelsPayload {
  provider_type: DesktopProviderKind
  base_url?: string
  api_key?: string
  access_token?: string
  models_path?: string
  auth_header?: string
  auth_scheme?: CustomProviderAuthScheme
}

export interface DiscoverProviderModelsResponse {
  provider_type: DesktopProviderKind
  endpoint: string
  models: string[]
  fetched_at: string
}
