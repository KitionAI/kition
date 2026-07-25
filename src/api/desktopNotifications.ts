import request from './request'
import type { DesktopHook, DesktopHookEvent, DesktopNotificationPolicy } from '@/types/desktopSettings'

export type DesktopHookWritePayload = {
  name: string
  event: DesktopHookEvent
  matcher?: string
  command: string
  workdir?: string
  timeout_seconds: number
  enabled?: boolean
}

export type DesktopHookDTO = {
  id: number
  name: string
  event: DesktopHookEvent
  matcher: string
  command: string
  workdir: string
  timeout_seconds: number
  enabled: boolean
  last_run_at?: string
  last_exit_code?: number
  created_at: string
  updated_at: string
}

export type DesktopHookDryRunResult = {
  command: string
  shell: string
  workdir: string
  timeout_seconds: number
  event: DesktopHookEvent
  would_dispatch: boolean
}

export type DesktopNotificationPolicyDTO = {
  system_notifications_enabled: boolean
  on_task_completed: boolean
  on_task_failed: boolean
  on_user_input_needed: boolean
  long_running_threshold_seconds: number
}

export function getNotificationPolicy() {
  return request.get<DesktopNotificationPolicyDTO>('/v1/desktop/notifications')
}

export function putNotificationPolicy(policy: DesktopNotificationPolicyDTO) {
  return request.put<DesktopNotificationPolicyDTO>('/v1/desktop/notifications', policy)
}

export function listHooks() {
  return request.get<{ items: DesktopHookDTO[] }>('/v1/desktop/hooks')
}

export function createHook(payload: DesktopHookWritePayload) {
  return request.post<DesktopHookDTO>('/v1/desktop/hooks', payload)
}

export function updateHook(id: number, payload: DesktopHookWritePayload) {
  return request.put<DesktopHookDTO>(`/v1/desktop/hooks/${id}`, payload)
}

export function deleteHook(id: number) {
  return request.delete<{ message: string }>(`/v1/desktop/hooks/${id}`)
}

export function dryRunHook(id: number) {
  return request.post<DesktopHookDryRunResult>(`/v1/desktop/hooks/${id}/dry-run`)
}

export type DesktopLifecycleEvent = 'session_started' | 'on_quit'

export function dispatchLifecycleHook(event: DesktopLifecycleEvent) {
  return request.post<{ message: string }>('/v1/desktop/hooks/lifecycle', { event })
}

export function policyFromDTO(dto: DesktopNotificationPolicyDTO): DesktopNotificationPolicy {
  return {
    systemNotificationsEnabled: dto.system_notifications_enabled,
    onTaskCompleted: dto.on_task_completed,
    onTaskFailed: dto.on_task_failed,
    onUserInputNeeded: dto.on_user_input_needed,
    longRunningThresholdSeconds: dto.long_running_threshold_seconds,
  }
}

export function policyToDTO(policy: DesktopNotificationPolicy): DesktopNotificationPolicyDTO {
  return {
    system_notifications_enabled: policy.systemNotificationsEnabled,
    on_task_completed: policy.onTaskCompleted,
    on_task_failed: policy.onTaskFailed,
    on_user_input_needed: policy.onUserInputNeeded,
    long_running_threshold_seconds: policy.longRunningThresholdSeconds,
  }
}

export function hookFromDTO(dto: DesktopHookDTO): DesktopHook {
  return {
    id: String(dto.id),
    name: dto.name,
    enabled: dto.enabled,
    event: dto.event,
    matcher: dto.matcher,
    command: dto.command,
    workdir: dto.workdir,
    timeoutSeconds: dto.timeout_seconds,
  }
}
