import { AiGenerateError, generateForKit, type AiGenerateRequest } from '@/api/aiGenerate'
import { loadDesktopSettings } from '@/services/desktopSettings'
import { buildDesktopRuntimeModel, canUseDesktopProvider, resolvePreferredDesktopMediaModel } from '@/services/mediaModels'
import { ensurePortalAccountSessionRestored } from '@/services/portalAccount'
import type { DesktopProviderKind } from '@/types/desktopSettings'
import type { RuntimeWritingModel } from '@/types'
import { KitRpcError, type KitGeneratePart, type KitGenerateParams, type KitGenerateResult } from '../host/protocol'

/** A refusal of `host/generate` (Kit UI protocol section 7j), with its reason. */
function refuse(reason: string, message: string): never {
  throw new KitRpcError(-32000, message, { reason })
}

/**
 * The model the person's settings choose for a kit's generation: the document's preference when
 * it names one of the person's models (`desktop:<provider>:<model>`, as AI fields store it), the
 * preferred image model for images, and the active provider's model for text. The kit's
 * preference is a hint only (UI-G2): a model the person has not set up is never used.
 */
export async function resolveGenerateRuntimeModel(output: 'text' | 'image', preference?: string): Promise<RuntimeWritingModel | undefined> {
  const named = preference?.match(/^desktop:([^:]+):(.+)$/)
  let settings = await loadDesktopSettings()
  const providerKind = (named?.[1] || settings.models.activeProvider) as DesktopProviderKind
  if (providerKind === 'kition_console') {
    await ensurePortalAccountSessionRestored()
    settings = await loadDesktopSettings()
  }
  if (named) {
    const provider = settings.providers[providerKind]
    if (provider && canUseDesktopProvider(providerKind, provider)) return buildDesktopRuntimeModel(providerKind, provider, named[2])
  }
  if (output === 'image') return resolvePreferredDesktopMediaModel(settings, 'image')
  const active = settings.models.activeProvider
  const provider = settings.providers[active]
  if (!provider || !canUseDesktopProvider(active, provider)) return undefined
  const modelName = settings.models.selectedModelByProvider[active]
    || settings.models.preferredWritingModel
    || settings.models.preferredChatModel
    || settings.models.preferredDefaultModel
    || provider.discoveredModels?.[0]
    || ''
  return modelName ? buildDesktopRuntimeModel(active, provider, modelName) : undefined
}

function toBase64(bytes: ArrayBuffer) {
  const view = new Uint8Array(bytes)
  let binary = ''
  for (let index = 0; index < view.length; index += 0x8000) binary += String.fromCharCode(...view.subarray(index, index + 0x8000))
  return btoa(binary)
}

function fromBase64(text: string) {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes.buffer
}

function requestPart(part: KitGeneratePart): AiGenerateRequest['messages'][number]['parts'][number] {
  if (part.type === 'text') return { type: 'text', text: part.text }
  if ('bytes' in part) return { type: 'image', mime: part.mime, data: toBase64(part.bytes) }
  return { type: 'image', url: part.url }
}

/**
 * `host/generate` for a kit (Kit UI protocol 2.2 section 7j): runs the kit's prompt on the
 * person's model through the runtime, which logs its usage; the kit writes the answer into its
 * document itself. Kition generates for AI fields (`ai-field`) only.
 */
export async function kitionGenerate(params: KitGenerateParams): Promise<KitGenerateResult> {
  if (params.purpose !== 'ai-field') refuse('not-allowed', `Kition does not generate for ${String(params.purpose)}`)
  if (params.output !== 'text' && params.output !== 'image') refuse('failed', `unknown output ${String(params.output)}`)
  if (!Array.isArray(params.messages) || !params.messages.length) refuse('failed', 'the request has no messages')
  const runtimeModel = await resolveGenerateRuntimeModel(params.output, params.model).catch((error: unknown) => refuse('unavailable', error instanceof Error ? error.message : String(error)))
  if (!runtimeModel) refuse('unavailable', 'Configure a model in Settings first.')
  try {
    const answer = await generateForKit({
      purpose: 'ai-field',
      output: params.output,
      runtimeModel: runtimeModel as AiGenerateRequest['runtimeModel'],
      messages: params.messages.map((message) => ({ role: message.role, parts: message.parts.map(requestPart) })),
      ...(params.options ? { options: params.options } : {}),
    })
    return {
      ...(answer.text != null ? { text: answer.text } : {}),
      ...(answer.image ? { image: { mime: answer.image.mime, bytes: fromBase64(answer.image.data) } } : {}),
      model: answer.model,
      ...(answer.usage ? { usage: answer.usage } : {}),
    }
  } catch (error) {
    // A refusal names its reason (`AiGenerateError`); anything else failed.
    const reason = error instanceof AiGenerateError ? error.reason : (error as { reason?: unknown } | null)?.reason
    refuse(typeof reason === 'string' ? reason : 'failed', error instanceof Error ? error.message : String(error))
  }
}
