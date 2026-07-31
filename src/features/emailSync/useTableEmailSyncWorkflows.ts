import { useCallback, useEffect, useState } from 'react'

import { EMAIL_AUTOMATION_TABLE_PATH } from '@/features/onboarding/onboardingGuideManifest'
import { getDesktopBackendStatus } from '@/services/desktop'
import {
  EMAIL_SYNC_CHANGED_EVENT,
  listEmailSyncRuns,
  listEmailSyncWorkflows,
  type EmailSyncRun,
  type EmailSyncWorkflow,
  updateEmailSyncWorkflow,
} from './api'

export const LEGACY_DEFAULT_EMAIL_SYNC_TABLE_PATH = 'Mail/Emails.kitable'

export type TableEmailSyncWorkflowState = {
  status: 'loading' | 'ready' | 'error'
  supported: boolean
  workflows: EmailSyncWorkflow[]
  latestRuns: Record<string, EmailSyncRun | null>
  error: string
}

export function useEmailSyncCapability(enabled = true): boolean | null {
  const [supported, setSupported] = useState<boolean | null>(enabled ? null : false)

  useEffect(() => {
    if (!enabled) {
      setSupported(false)
      return
    }
    let active = true
    void getDesktopBackendStatus()
      .then((status) => {
        if (active) setSupported(Boolean(status.capabilities?.includes('email_sync')))
      })
      .catch(() => {
        if (active) setSupported(false)
      })
    return () => {
      active = false
    }
  }, [enabled])

  return supported
}

export function useTableEmailSyncWorkflows(tablePath?: string): TableEmailSyncWorkflowState {
  const [state, setState] = useState<TableEmailSyncWorkflowState>({
    status: 'loading',
    supported: false,
    workflows: [],
    latestRuns: {},
    error: '',
  })

  const load = useCallback(async (showLoading = true) => {
    if (showLoading) setState((current) => ({ ...current, status: 'loading', error: '' }))
    try {
      const runtime = await getDesktopBackendStatus().catch(() => null)
      const supported = Boolean(runtime?.capabilities?.includes('email_sync'))
      if (!supported) {
        setState({ status: 'ready', supported: false, workflows: [], latestRuns: {}, error: '' })
        return
      }
      const allWorkflows = await listEmailSyncWorkflows()
      const binding = tablePath
        ? resolveEmailSyncTableBinding(allWorkflows, tablePath)
        : { workflows: allWorkflows, migrationCandidate: null }
      const workflows = binding.migrationCandidate
        ? [await updateEmailSyncWorkflow(binding.migrationCandidate.id, {
          target: {
            ...binding.migrationCandidate.target,
            table_path: normalizeEmailSyncTablePath(tablePath!),
          },
        })]
        : binding.workflows
      const runEntries = await Promise.all(workflows.map(async (workflow) => {
        const runs = await listEmailSyncRuns(workflow.id, 1).catch(() => [])
        return [workflow.id, runs[0] || null] as const
      }))
      setState({
        status: 'ready',
        supported: true,
        workflows,
        latestRuns: Object.fromEntries(runEntries),
        error: '',
      })
    } catch (error) {
      setState({
        status: 'error',
        supported: true,
        workflows: [],
        latestRuns: {},
        error: error instanceof Error ? error.message : 'Failed to load email sync workflows',
      })
    }
  }, [tablePath])

  useEffect(() => {
    void load(true)
    const handleChanged = () => { void load(false) }
    window.addEventListener(EMAIL_SYNC_CHANGED_EVENT, handleChanged)
    return () => window.removeEventListener(EMAIL_SYNC_CHANGED_EVENT, handleChanged)
  }, [load])

  const hasActiveRun = Object.values(state.latestRuns).some((run) => (
    run && ['queued', 'scanning', 'running', 'canceling'].includes(run.status)
  ))
  useEffect(() => {
    if (!hasActiveRun) return
    const timer = window.setInterval(() => { void load(false) }, 1000)
    return () => window.clearInterval(timer)
  }, [hasActiveRun, load])

  return state
}

export function normalizeEmailSyncTablePath(path: string) {
  return path.replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '')
}

export function filterEmailSyncWorkflowsByTablePath(workflows: EmailSyncWorkflow[], tablePath: string) {
  const normalizedTarget = normalizeEmailSyncTablePath(tablePath)
  return workflows.filter((workflow) => (
    normalizeEmailSyncTablePath(workflow.target.table_path) === normalizedTarget
  ))
}

export function resolveEmailSyncTableBinding(workflows: EmailSyncWorkflow[], tablePath: string) {
  const matches = filterEmailSyncWorkflowsByTablePath(workflows, tablePath)
  if (matches.length > 0 || normalizeEmailSyncTablePath(tablePath) !== EMAIL_AUTOMATION_TABLE_PATH) {
    return { workflows: matches, migrationCandidate: null }
  }

  const legacyCandidates = workflows.filter((workflow) => (
    workflow.synced_messages === 0
    && normalizeEmailSyncTablePath(workflow.target.table_path) === LEGACY_DEFAULT_EMAIL_SYNC_TABLE_PATH
  ))
  return {
    workflows: matches,
    migrationCandidate: legacyCandidates.length === 1 ? legacyCandidates[0] : null,
  }
}
