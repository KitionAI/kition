import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getImageTemplate } from '@/features/media-generation/api/imageTemplates'
import type { ImageTemplateSummary } from '@/features/media-generation/lib/imageTemplateContract'
import type { AgentImageArtifact, AgentImageGenerationIntent, AgentImageTarget } from '@/types/imageGeneration'

export type AgentImageOptions = Pick<AgentImageGenerationIntent,
  'aspect_ratio' | 'quality' | 'resolution' | 'variants' | 'text_mode'>
const defaults: AgentImageOptions = {
  aspect_ratio: '1:1', quality: 'medium', resolution: '1K', variants: 1, text_mode: 'baked_text',
}

export function useAgentImageMode(input: {
  sessionId: number
  target?: AgentImageTarget
  available: boolean
  accessToken?: string
  referencePaths: string[]
  draft: string
  busy: boolean
  canSend: boolean
  onDraftChange: (value: string) => void
  onSend: (intent?: AgentImageGenerationIntent) => void
}) {
  const { t, i18n } = useTranslation('imageGeneration')
  const [enabled, setEnabled] = useState(false)
  const [configuring, setConfiguring] = useState(false)
  const [browsing, setBrowsing] = useState(false)
  const [template, setTemplate] = useState<ImageTemplateSummary>()
  const [variables, setVariables] = useState<Record<string, string>>({})
  const [options, setOptions] = useState(defaults)
  const [editReference, setEditReference] = useState<string>()
  const [referenceOverrides, setReferenceOverrides] = useState<string[]>()
  const [error, setError] = useState('')
  const [preparing, setPreparing] = useState(false)
  const requests = useRef(new Map<string, { intent: AgentImageGenerationIntent; template?: ImageTemplateSummary }>())
  const controller = useRef<AbortController | null>(null)
  const contextKey = `${input.sessionId}:${JSON.stringify(input.target)}:${input.accessToken || ''}:${input.available}`
  const currentContext = useRef(contextKey)
  currentContext.current = contextKey
  useEffect(() => () => controller.current?.abort(), [])
  useEffect(() => {
    controller.current?.abort()
    controller.current = null
    setPreparing(false)
    setError('')
  }, [contextKey])
  const previousSession = useRef(input.sessionId)
  const previousToken = useRef(input.accessToken)
  useEffect(() => {
    if (previousSession.current === input.sessionId) return
    previousSession.current = input.sessionId
    setEnabled(false)
    setConfiguring(false)
    setBrowsing(false)
    setTemplate(undefined)
    setVariables({})
    setOptions(defaults)
    setEditReference(undefined)
    setReferenceOverrides(undefined)
    requests.current.clear()
  }, [input.sessionId])
  useEffect(() => {
    if (previousToken.current === input.accessToken) return
    previousToken.current = input.accessToken
    setTemplate(undefined)
    setVariables({})
    requests.current.clear()
  }, [input.accessToken])

  const referencePaths = [...new Set([...(editReference ? [editReference] : []), ...(referenceOverrides || input.referencePaths)])].slice(0, 8)
  const missingVariables = template?.variables.some((variable) => variable.required && !variables[variable.key]?.trim())
  const referenceRequired = Boolean((editReference || template?.operation === 'edit' || template?.requires_reference_image) && !referencePaths.length)
  const accountRequired = Boolean(template && template.access !== 'public' && !input.accessToken)
  const instruction = input.draft.trim() || (template
    ? [template.title, ...template.variables.map((variable) => variables[variable.key]?.trim()).filter(Boolean)].join('\n').slice(0, 12000)
    : '')
  const blockedReason = !input.available ? t('chat.runtimeUnavailable')
    : !input.target ? t('chat.targetRequired')
    : accountRequired ? t('chat.accountRequired')
    : referenceRequired ? t('chat.referenceRequired')
    : missingVariables ? t('chat.variablesRequired') : ''

  function selectTemplate(next?: ImageTemplateSummary) {
    setTemplate(next)
    setVariables({})
    setError('')
    if (next) setOptions({
      aspect_ratio: next.default_aspect_ratio,
      quality: next.default_quality,
      resolution: next.default_resolution,
      variants: 1,
      text_mode: next.default_text_mode,
    })
    setBrowsing(false)
    if (next) setConfiguring(true)
  }

  async function send() {
    if (!enabled) { input.onSend(); return }
    if (blockedReason || !instruction || !input.canSend || input.busy || controller.current || !input.target) return
    const abort = new AbortController()
    controller.current = abort
    setPreparing(true)
    setError('')
    const keyAtSend = contextKey
    try {
      if (template) {
        const fresh = await getImageTemplate({
          id: template.id, version: template.version,
          locale: i18n.language, accessToken: input.accessToken, signal: abort.signal,
        })
        if ((fresh.access !== 'public' && !input.accessToken)
          || ((fresh.requires_reference_image || fresh.operation === 'edit') && !referencePaths.length)) {
          throw new Error('Template requirements are not met')
        }
        if (fresh.variables.some((variable) => variable.required && !variables[variable.key]?.trim())) {
          throw new Error('Template variables are incomplete')
        }
      }
      if (abort.signal.aborted || currentContext.current !== keyAtSend) return
      const intent: AgentImageGenerationIntent = {
        type: 'image_generation.intent', schema_version: 1,
        request_id: crypto.randomUUID(), client_capability_version: 1,
        operation: editReference ? 'edit' : template?.operation || 'generate',
        instruction, locale: i18n.language,
        ...options,
        ...(template ? { template_id: template.id, template_version: template.version, template_variables: variables } : {}),
        reference_paths: referencePaths,
        surface: input.target.type === 'image.target.table' ? 'table'
          : input.target.type === 'image.target.whiteboard' ? 'whiteboard' : 'document',
        target: input.target,
        placement_preference: 'review',
      }
      requests.current.set(intent.request_id, { intent, template })
      if (requests.current.size > 100) requests.current.delete(requests.current.keys().next().value!)
      input.onSend(intent)
      setConfiguring(false)
    } catch {
      if (!abort.signal.aborted) setError(t('chat.templateUnavailable'))
    } finally {
      if (controller.current === abort) {
        controller.current = null
        setPreparing(false)
      }
    }
  }

  function edit(artifact: AgentImageArtifact) {
    setEnabled(true)
    setTemplate(undefined)
    setVariables({})
    setEditReference(artifact.path)
    setReferenceOverrides(undefined)
    setBrowsing(false)
    input.onDraftChange(t('chat.editPrompt'))
    window.dispatchEvent(new Event('kition:agent:focus-composer'))
  }

  function retry(requestId: string) {
    const saved = requests.current.get(requestId)
    if (!saved) return
    const { intent } = saved
    setEnabled(true)
    const { aspect_ratio, quality, resolution, variants, text_mode } = intent
    setOptions({ aspect_ratio, quality, resolution, variants, text_mode })
    setVariables(intent.template_variables || {})
    setEditReference(intent.operation === 'edit' ? intent.reference_paths[0] : undefined)
    setReferenceOverrides(intent.reference_paths)
    // The selected immutable version stays pinned for retries in this composer.
    setTemplate(saved.template)
    input.onDraftChange(intent.instruction)
    window.dispatchEvent(new Event('kition:agent:focus-composer'))
  }

  return {
    enabled, setEnabled, configuring, setConfiguring, browsing, setBrowsing, template, selectTemplate,
    variables, setVariables, options, setOptions, editReference,
    removeReference: (path: string) => {
      if (editReference === path) setEditReference(undefined)
      setReferenceOverrides(referencePaths.filter((reference) => reference !== path))
    },
    error, preparing, blockedReason, referencePaths, instruction, send, edit, retry,
    canRetry: (id: string) => requests.current.has(id),
  }
}
export type AgentImageMode = ReturnType<typeof useAgentImageMode>
