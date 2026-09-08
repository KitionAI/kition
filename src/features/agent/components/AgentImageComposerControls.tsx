import { ArrowLeft, ImagePlus, Loader2, SlidersHorizontal, X } from 'lucide-react'
import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/registry/ui/popover'
import { cn } from '@/lib/utils'
import type { AgentImageMode } from '../hooks/useAgentImageMode'
import { useAgentImagePanelPlacement } from '../hooks/useAgentImagePanelPlacement'
import { AgentImageSettings } from './AgentImageSettings'
import { AgentImageTemplateBrowser } from './AgentImageTemplateBrowser'
import type { AgentImageGenerationSurface } from '@/types/imageGeneration'

export function AgentImageComposerControls({ mode, busy, surface, accessToken }: {
  mode: AgentImageMode
  busy: boolean
  surface: AgentImageGenerationSurface
  accessToken?: string
}) {
  const { t } = useTranslation('imageGeneration')
  const triggerRef = useRef<HTMLButtonElement>(null)
  const placement = useAgentImagePanelPlacement(mode.configuring, triggerRef)
  const close = () => { mode.setConfiguring(false); focusComposer() }
  return (
    <Popover open={mode.configuring} onOpenChange={(open) => {
      mode.setConfiguring(open)
      if (open) { mode.setEnabled(true); mode.setBrowsing(true) }
      else mode.setBrowsing(false)
    }}>
      <div className={cn('agent-composer-image', mode.enabled && 'is-active')}>
        <PopoverTrigger asChild>
          <button ref={triggerRef} type="button" className={cn('agent-composer-tool', mode.enabled && 'rounded-r-none')}
            disabled={busy || mode.preparing} aria-label={t('chat.mode')} aria-pressed={mode.enabled}
            title={t('chat.templates')} data-testid="agent-image-mode">
            <ImagePlus className="size-4 shrink-0" aria-hidden="true" />
            {mode.enabled ? <span className="agent-composer-image__label">{t('chat.mode')}</span> : null}
          </button>
        </PopoverTrigger>
        {mode.enabled ? <button type="button" className="agent-composer-tool agent-composer-image__exit"
          disabled={busy || mode.preparing} aria-label={t('chat.exitImageMode')} title={t('chat.exitImageMode')}
          onClick={() => {
            mode.setEnabled(false)
            mode.setConfiguring(false)
            mode.setBrowsing(false)
            focusComposer()
          }}><X className="size-3.5" aria-hidden="true" /></button> : null}
      </div>
      {/* Register the explicit anchor after the trigger's fallback anchor. */}
      <PopoverAnchor virtualRef={placement.anchor} />
      <PopoverContent side={placement.overlay ? 'bottom' : 'left'} align={placement.overlay ? 'start' : 'end'}
        sideOffset={placement.overlay ? 0 : 12} collisionPadding={12}
        style={{ width: placement.width, height: placement.height }}
        data-layout={placement.overlay ? 'overlay' : 'left'}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          const focused = document.activeElement
          if (!focused || focused === document.body || focused === triggerRef.current) {
            focusComposer()
          }
        }}
        className="agent-composer-popover agent-image-popover rounded-xl" aria-label={t('chat.imageSettings')}>
        <AgentImageTemplateBrowser active={mode.browsing} surface={surface} accessToken={accessToken}
          hasReferenceImage={mode.referencePaths.length > 0} onSelect={mode.selectTemplate}
          onFreeform={() => { mode.selectTemplate(); close() }}
          onSettings={() => mode.setBrowsing(false)} onClose={close} />
        {!mode.browsing ? <>
          <div className="agent-image-panel-header">
            <button type="button" className="agent-composer-tool" onClick={() => mode.setBrowsing(true)}>
              <ArrowLeft className="size-4" aria-hidden="true" />{t('chat.templates')}
            </button>
            <strong className="text-sm font-medium">{t('chat.imageSettings')}</strong>
            <button type="button" className="agent-composer-tool size-7 !p-0" aria-label={t('chat.closeSettings')}
              onClick={close}><X className="size-4" /></button>
          </div>
          <AgentImageSettings mode={mode} busy={busy} />
        </> : null}
      </PopoverContent>
    </Popover>
  )
}

export function AgentImageComposerSummary({ mode, busy }: { mode: AgentImageMode; busy: boolean }) {
  const { t } = useTranslation('imageGeneration')
  if (!mode.enabled) return null
  const status = mode.error || mode.blockedReason || (mode.preparing ? t('chat.checkingTemplate') : '')
  if (!mode.template && !mode.editReference && !status) return null
  return <button type="button" className={cn('agent-image-summary', mode.error && 'text-destructive')}
    disabled={busy || mode.preparing} onClick={() => { mode.setBrowsing(false); mode.setConfiguring(true) }} data-testid="agent-image-summary"
    title={status || t('chat.imageSettings')}>
    {mode.template ? <img src={mode.template.thumbnail.url} alt="" referrerPolicy="no-referrer" className="size-6 shrink-0 rounded object-cover" />
      : mode.preparing ? <Loader2 className="size-3.5 shrink-0 animate-spin" /> : <ImagePlus className="size-3.5 shrink-0" />}
    <span className="min-w-0 flex-1">
      <span className="block truncate">{mode.template?.title || (mode.editReference ? t('chat.edit') : status)}</span>
      {status && (mode.template || mode.editReference) ? <span role="status" className="mt-0.5 block text-[11px] text-muted-foreground">{status}</span> : null}
    </span>
    <span className="shrink-0 text-[11px] text-muted-foreground">{mode.template ? mode.options.aspect_ratio : null}</span>
    <SlidersHorizontal className="size-3.5 shrink-0 text-muted-foreground" />
  </button>
}

function focusComposer() { requestAnimationFrame(() => window.dispatchEvent(new Event('kition:agent:focus-composer'))) }
