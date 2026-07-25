import request from './request'
import { resolveApiURL } from '@/services/desktop'
import type { DiscoverProviderModelsPayload, DiscoverProviderModelsResponse } from '@/types/desktopSettings'

export function discoverProviderModels(data: DiscoverProviderModelsPayload) {
  return request
    .post<DiscoverProviderModelsResponse | { data?: DiscoverProviderModelsResponse }>(
      '/v1/desktop/providers/discover-models',
      data,
    )
    .then((response: any) => response?.data || response)
}

export type BootstrapChallengeRequest = {
  startup_id: string
  official_build: boolean
  build_channel: string
  platform: string
  app_version: string
  build_version?: string
  build_commit?: string
  installation_id: string
}

export type BootstrapChallengeResponse = {
  official_build: boolean
  build_channel: string
  startup_id: string
  challenge_id: string
  challenge: string
  expires_at: string
  server_time: string
  bootstrap_policy: {
    official_required: boolean
    blocked_on_failure: boolean
    retry_allowed: boolean
    max_attempts_hint: number
  }
  diagnostics: {
    code: string
    title: string
    message: string
    detail: string
    support_id: string
    retryable: boolean
    next_action: string
  }
}

export type BootstrapCompleteRequest = {
  startup_id: string
  challenge_id: string
  official_build: boolean
  build_channel: string
  platform: string
  runtime: {
    app_version: string
    build_version?: string
    build_commit?: string
    os_version: string
    arch: string
    hostname_hash?: string
  }
  installation: {
    installation_id: string
    installation_proof: string
    sequence?: number
  }
  attestation: any
}

export type BootstrapCompleteResponse = {
  official_build: boolean
  build_channel: string
  bootstrap_status: string
  startup_mode: string
  startup_id: string
  provider: null | {
    kind: string
    label: string
    base_url: string
    api_key: string
    models_path: string
  }
  device: {
    canonical_status: string
    installation_status: string
  }
  diagnostics: {
    code: string
    title: string
    message: string
    detail: string
    support_id: string
    retryable: boolean
    next_action: string
  }
}

export type DesktopBootstrapEnvelope<T> = {
  code: number
  message: string
  data: T
}

async function postBootstrap<T>(path: string, payload: unknown): Promise<DesktopBootstrapEnvelope<T>> {
  const response = await fetch(resolveApiURL(path), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  let body: DesktopBootstrapEnvelope<T> | null = null
  try {
    body = await response.json()
  } catch {
    // noop
  }

  if (!response.ok || !body) {
    const error: any = new Error(body?.message || `bootstrap request failed (${response.status})`)
    error.status = response.status
    error.payload = body
    throw error
  }

  return body
}

export function requestBootstrapChallenge(payload: BootstrapChallengeRequest) {
  return postBootstrap<BootstrapChallengeResponse>('/v1/desktop/bootstrap/challenge', payload)
}

export function completeBootstrap(payload: BootstrapCompleteRequest) {
  return postBootstrap<BootstrapCompleteResponse>('/v1/desktop/bootstrap/complete', payload)
}

export type PortalConnectStartResponse = {
  session_id: string
  authorize_url: string
  expires_at: string
  poll_interval_ms: number
}

export type PortalAccountSession = {
  access_token: string
  token_prefix: string
  user_id: number
  user_email: string
  expires_at: string
  credit_total?: number
  credit_balance?: number
  credit_spent?: number
  period_credit_total?: number
  period_credit_balance?: number
  period_credit_spent?: number
  wallet_credit_total?: number
  wallet_credit_balance?: number
  wallet_credit_spent?: number
  plan_code?: string
  plan_display_name?: string
  plan_type?: string
  subscription_status?: string
  credit_purchased_total?: number
  credit_granted_total?: number
  lifetime_credit_total?: number
  credit_reset_cycle?: string
  credit_reset_at?: string | null
  billing_url?: string
  topup_url?: string
  support_url?: string
  terms_url?: string
  privacy_url?: string
  credit_summary?: PortalCreditSummary
}

export type PortalCreditSummary = {
  credit_total?: number
  credit_balance?: number
  credit_spent?: number
  period_credit_total?: number
  period_credit_balance?: number
  period_credit_spent?: number
  wallet_credit_total?: number
  wallet_credit_balance?: number
  wallet_credit_spent?: number
  plan_code?: string
  plan_display_name?: string
  plan_type?: string
  subscription_status?: string
  credit_purchased_total?: number
  credit_granted_total?: number
  lifetime_credit_total?: number
  credit_reset_cycle?: string
  credit_reset_at?: string | null
}

export type PortalConnectResultResponse = {
  status: 'pending' | 'completed' | 'error' | 'expired'
  expires_at: string
  session?: PortalAccountSession
  error_message?: string
}

export type PortalSessionStatusResponse = {
  authenticated: boolean
  user_id?: number
  user_email?: string
  token_prefix?: string
  expires_at?: string
  credit_total?: number
  credit_balance?: number
  credit_spent?: number
  period_credit_total?: number
  period_credit_balance?: number
  period_credit_spent?: number
  wallet_credit_total?: number
  wallet_credit_balance?: number
  wallet_credit_spent?: number
  plan_code?: string
  plan_display_name?: string
  plan_type?: string
  subscription_status?: string
  credit_purchased_total?: number
  credit_granted_total?: number
  lifetime_credit_total?: number
  credit_reset_cycle?: string
  credit_reset_at?: string | null
  billing_url?: string
  topup_url?: string
  support_url?: string
  terms_url?: string
  privacy_url?: string
  credit_summary?: PortalCreditSummary
}

export function startPortalConnect() {
  return request
    .post<PortalConnectStartResponse | { data?: PortalConnectStartResponse }>(
      '/v1/desktop/portal/connect/start',
      {},
    )
    .then((response: any) => response?.data || response)
}

export function getPortalConnectResult(sessionID: string) {
  return request
    .get<PortalConnectResultResponse | { data?: PortalConnectResultResponse }>(
      `/v1/desktop/portal/connect/result/${encodeURIComponent(sessionID)}`,
    )
    .then((response: any) => response?.data || response)
}

export function getPortalSessionStatus(accessToken: string) {
  return request
    .post<PortalSessionStatusResponse | { data?: PortalSessionStatusResponse }>(
      '/v1/desktop/portal/session/status',
      { access_token: accessToken },
    )
    .then((response: any) => response?.data || response)
}

export function logoutPortalSession(accessToken: string) {
  return request
    .post<{ success: boolean } | { data?: { success: boolean } }>(
      '/v1/desktop/portal/logout',
      { access_token: accessToken },
    )
    .then((response: any) => response?.data || response)
}
