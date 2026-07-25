export const customAuthSchemeOptions = [
  { label: 'Bearer', value: 'bearer' },
  { label: 'Raw', value: 'raw' },
  { label: 'X-API-Key', value: 'x-api-key' },
] as const

export const customWireApiOptions = [
  { label: 'OpenAI Responses (Agent)', value: 'responses' },
  { label: 'Anthropic Messages (Agent)', value: 'anthropic_messages' },
] as const

export const hostedWebSearchVersionOptions = [
  { label: 'web_search_20260209 (latest)', value: '20260209' },
  { label: 'web_search_20250305 (legacy)', value: '20250305' },
] as const

export const customReasoningOptions = [
  { label: 'Minimal', value: 'minimal' },
  { label: 'Low', value: 'low' },
  { label: 'Medium', value: 'medium' },
  { label: 'High', value: 'high' },
] as const
