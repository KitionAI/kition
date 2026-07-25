import { useEffect, useMemo, useState } from 'react'

import { useWorkflowBuild } from '../hooks/useWorkflowBuild'
import type { WorkflowBuildInput } from '../hooks/useWorkflowBuild'
import type { TableSchema } from '../components/BodyTemplateEditor.types'
import { openWorkflowHome, openWorkflowDetail, type WorkflowRouteContext } from '../lib/openWorkflowRoute'
import {
  eventsToPreviewWorkflow,
  eventsToProgressState,
  findCreatedWorkflowId,
  withStreamingId,
} from '../lib/aiBuildPreview'
import { WorkflowNewPage } from './WorkflowNewPage'
import { WorkflowHomePage, type StreamingPreview } from './WorkflowHomePage'
import { WorkflowIndexPage } from './WorkflowIndexPage'
import { EmailSyncWorkflowPage } from '@/features/emailSync/EmailSyncWorkflowPage'

export interface WorkflowRouteProps {
  workflowContext: WorkflowRouteContext | null
  schemaLookup: (documentId: string, tableId: string) => Promise<TableSchema>
  /** Keeps index/detail/build surfaces scoped to the kitable that launched
   *  the workflow route instead of falling back to the workspace-global list. */
  scopedKitablePath?: string
  /** Wired by Shell so Home and Build can fully unmount the route via React state. */
  onExit?: () => void
  /** Active workspace root. Forwarded to the no-context AI prompt page
   *  so its inline table picker (and the "Create a table" CTA) stay
   *  scoped to the workspace the user is in. Undefined falls back to a
   *  cross-workspace lookup, which is acceptable for legacy mounts. */
  rootPath?: string
}

/**
 * Resolves which view to show based on URL + provided context. Expressed as
 * named modes so the conditionals read top-down instead of as inverted guards.
 *
 *   /workflow                          → mode 'index'    (list of workflows)
 *   /workflow/{id} (id is uuid)        → mode 'detail'   (detail + edit flow)
 *   /workflow/new without context      → mode 'home-with-mode-dialog'
 *                                          (open the create-mode chooser on
 *                                           top of Home; delayed table
 *                                           binding lets the user pick the
 *                                           table inside the editor) — UNLESS
 *                                          the URL says ?mode=ai, in which
 *                                          case we land directly on the AI
 *                                          prompt page with empty context so
 *                                          the user can describe what they
 *                                          want before binding a table. The
 *                                          old behaviour silently dropped
 *                                          them back into the same dialog,
 *                                          which read as "click was a no-op".
 *   /workflow/new with context         → mode 'build'   (create + edit flow)
 *
 * Build / ai-no-context modes both render WorkflowHomePage while the AI
 * stream is in flight — the home page accepts a `streamingPreview` prop and
 * paints the synthetic workflow into its existing list / canvas / drawer
 * machinery. The old standalone WorkflowAiBuildSurface is gone.
 */
type RouteMode = 'index' | 'detail' | 'home-with-mode-dialog' | 'ai-no-context' | 'build'

function resolveRouteMode(workflowContext: WorkflowRouteContext | null): RouteMode {
  const pathname = window.location.pathname

  // Check for detail mode: /workflow/{id} where id is anything that isn't
  // 'new'. The public wire contract permits ids such as `auto_<uuid>`, so the
  // regex must allow underscores alongside bare hex/uuid characters. A
  // stricter `[a-f0-9-]+` silently routed every detail URL to the index page.
  const detailMatch = pathname.match(/^\/workflow\/([A-Za-z0-9_-]+)$/)
  if (detailMatch) {
    const id = detailMatch[1]
    // 'new' is not a uuid format, so this won't match
    if (id !== 'new') {
      return 'detail'
    }
  }

  const isCreateRoute = pathname.startsWith('/workflow/new')
  if (!isCreateRoute && pathname === '/workflow') return 'index'
  if (isCreateRoute) {
    if (workflowContext) return 'build'
    if (resolveCreateSubMode() === 'ai') return 'ai-no-context'
    return 'home-with-mode-dialog'
  }

  // Fallback to index for any unmatched /workflow* paths
  return 'index'
}

/** Reads the create-flow sub-mode (chat AI vs. editor). The workspace mode
 *  dialog encodes its pick in *both* history.state and the URL query so we
 *  can recover it after a hard reload too. URL takes precedence — it's the
 *  observable contract our e2e tests assert against. */
function resolveCreateSubMode(): 'ai' | 'editor' {
  try {
    const params = new URLSearchParams(window.location.search)
    if (params.get('mode') === 'ai') return 'ai'
  } catch {
    // URL parsing should never throw on a real browser; in tests with weird
    // pathnames just fall through to history.state.
  }
  const state = window.history.state as { workflowMode?: unknown } | null
  if (state?.workflowMode === 'ai') return 'ai'
  return 'editor'
}

/** Picks up the selected-workflow hint that `openWorkflowHome({ workflowId })`
 *  writes into history.state. Read here (rather than inside Home) so the home page
 *  stays a controlled component driven purely by props. */
function readSelectedWorkflowIdFromHistory(): string | undefined {
  const state = window.history.state as { selectedWorkflowId?: unknown } | null
  const value = state?.selectedWorkflowId
  return typeof value === 'string' && value ? value : undefined
}

export function WorkflowRoute({ workflowContext, schemaLookup, scopedKitablePath, onExit, rootPath }: WorkflowRouteProps) {
  const build = useWorkflowBuild()
  const [schema, setSchema] = useState<TableSchema | null>(null)
  const [lastPrompt, setLastPrompt] = useState('')
  const [lastDocumentId, setLastDocumentId] = useState<string | undefined>(undefined)
  const mode = resolveRouteMode(workflowContext)

  // Reset build state when the table being automated changes, or when we drop
  // back to Home. Without this, a stale build leaks across navigations.
  useEffect(() => {
    build.reset()
    setSchema(null)
    setLastPrompt('')
    setLastDocumentId(undefined)
  }, [workflowContext?.documentId, workflowContext?.tableId, mode])

  const onSubmit = async ({ prompt, model, context }: { prompt: string; model: WorkflowBuildInput['model']; context: WorkflowRouteContext }) => {
    const { documentId, tableId } = context
    if (!documentId || !tableId) return
    const s = await schemaLookup(documentId, tableId)
    setSchema(s)
    setLastPrompt(prompt)
    setLastDocumentId(documentId)
    await build.submit({ prompt, baseId: 'b', documentId, tableId, model })
  }

  // Synthesize a streaming preview while the build pipeline is in flight. The
  // home page treats this as a virtual row pinned to the top of its list +
  // auto-selects it, locking all destructive controls until the row gets
  // replaced by the real persisted workflow.
  const createdId = useMemo(() => findCreatedWorkflowId(build.events), [build.events])
  const streamingPreview: StreamingPreview | null = useMemo(() => {
    if (build.status === 'idle') return null
    const raw = eventsToPreviewWorkflow(build.events, schema, lastDocumentId)
    return {
      workflow: raw ? withStreamingId(raw) : null,
      status: build.status,
      phase: eventsToProgressState(build.events, build.status),
      prompt: lastPrompt,
      error: build.error,
      schema,
      createdId,
    }
  }, [build.status, build.events, build.error, schema, lastDocumentId, lastPrompt, createdId])

  // Persist the real id into history.state the moment workflow.created arrives
  // so WorkflowHomePage can both pick it up via initialSelectedId on a future
  // mount AND read it inside its post-streaming transition effect. We use
  // replaceState rather than pushState so the back button still takes the
  // user back to the launcher (one step up) rather than re-living the
  // streaming surface.
  useEffect(() => {
    if (!createdId) return
    const prev = window.history.state || {}
    if ((prev as { selectedWorkflowId?: string }).selectedWorkflowId === createdId) return
    window.history.replaceState({ ...prev, selectedWorkflowId: createdId }, '', '/workflow')
  }, [createdId])

  if (mode === 'index') {
    return (
      <WorkflowIndexPage
        scopedKitablePath={scopedKitablePath}
        rootPath={rootPath}
        onSelectWorkflow={openWorkflowDetail}
        onClose={onExit}
      />
    )
  }

  if (mode === 'detail') {
    const detailMatch = window.location.pathname.match(/^\/workflow\/([A-Za-z0-9_-]+)$/)
    const workflowId = detailMatch?.[1]
    if (!workflowId) {
      // Shouldn't reach here, but fall back to index
      return (
        <WorkflowIndexPage
          scopedKitablePath={scopedKitablePath}
          rootPath={rootPath}
          onSelectWorkflow={openWorkflowDetail}
          onClose={onExit}
        />
      )
    }
    return (
      workflowId.startsWith('mail_') ? (
        <EmailSyncWorkflowPage workflowId={workflowId} />
      ) : (
        <WorkflowHomePage
          initialSelectedId={workflowId}
          scopedKitablePath={scopedKitablePath}
          rootPath={rootPath}
          onClose={onExit}
        />
      )
    )
  }

  if (mode === 'home-with-mode-dialog') {
    // /workflow/new without context — show the new index page with the
    // create-mode dialog already open on top. After the user picks a mode
    // (chat / template / scratch) the dialog routes to the appropriate
    // build surface; if they dismiss, they land on the index list rather
    // than the legacy two-column WorkflowHomePage.
    return (
      <WorkflowIndexPage
        initialModeDialogOpen
        scopedKitablePath={scopedKitablePath}
        rootPath={rootPath}
        onSelectWorkflow={openWorkflowDetail}
        onClose={onExit}
      />
    )
  }

  if (mode === 'ai-no-context' || mode === 'build') {
    // While the build pipeline is idle, the launcher renders normally and
    // collects the user's prompt + table pick. As soon as build.submit fires
    // we flip into WorkflowHomePage and pass the streamingPreview through —
    // there's no separate AI surface anymore.
    if (build.status === 'idle') {
      if (mode === 'ai-no-context') {
        return (
          <WorkflowNewPage
            tableName=""
            onSubmit={onSubmit}
            schemaLookup={schemaLookup}
            initialView="ai-prompt"
            rootPath={rootPath}
          />
        )
      }
      return (
        <WorkflowNewPage
          tableName={workflowContext!.tableName}
          documentId={workflowContext!.documentId}
          tableId={workflowContext!.tableId}
          onSubmit={onSubmit}
          schemaLookup={schemaLookup}
          initialView={resolveCreateSubMode() === 'ai' ? 'ai-prompt' : 'gallery'}
        />
      )
    }
    return (
      <WorkflowHomePage
        streamingPreview={streamingPreview}
        scopedKitablePath={scopedKitablePath}
        rootPath={rootPath}
        onStreamingComplete={() => build.reset()}
        onClose={onExit}
      />
    )
  }

  // Unreachable — the four modes are exhaustive — but keep TS happy.
  return null
}
