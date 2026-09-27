/* eslint-disable */
/**
 * GENERATED FILE. Do not edit.
 * Source: contracts/runtime/email-sync.schema.json
 * Regenerate with: pnpm run contracts:generate
 */

export type EmailSyncTlsMode = "tls" | "starttls" | "plain"

export type EmailSyncConnection = {
  host: string
  port: number
  tls_mode: EmailSyncTlsMode
  username: string
  mailbox: string
}

export type EmailSyncTarget = {
  table_path: string
  table_id?: number
  content_folder: string
  attachment_folder: string
}

export type EmailSyncSchedule = {
  enabled: boolean
  interval_minutes: number
}

export type EmailSyncWorkflow = {
  id: string
  name: string
  connection: EmailSyncConnection
  target: EmailSyncTarget
  schedule: EmailSyncSchedule
  include_attachments: boolean
  status: "active" | "paused" | "syncing" | "error"
  last_sync_at?: string
  last_error?: string
  synced_messages: number
  created_at: string
  updated_at: string
}

export type EmailSyncSaveInput = {
  name: string
  connection: EmailSyncConnection
  password?: string
  target: EmailSyncTarget
  schedule: EmailSyncSchedule
  include_attachments: boolean
}

export type EmailSyncSyncResult = {
  workflow_id: string
  imported: number
  updated: number
  skipped: number
  failed: number
  table_path: string
  started_at: string
  finished_at: string
}

export type EmailSyncSyncRun = {
  id: string
  workflow_id: string
  mode: "incremental" | "full" | "scheduled"
  status: "queued" | "scanning" | "running" | "completed" | "failed" | "canceling" | "canceled" | "interrupted"
  discovered_messages: number
  processed_messages: number
  imported: number
  updated: number
  skipped: number
  failed: number
  current_batch: number
  table_path: string
  error?: string
  started_at?: string
  finished_at?: string
  created_at: string
  updated_at: string
}

export type EmailSyncContract = EmailSyncWorkflow
