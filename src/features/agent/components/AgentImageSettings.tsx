import { X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Input, Textarea } from '@/components/ui'
import { cn } from '@/lib/utils'
import type { AgentImageMode, AgentImageOptions } from '../hooks/useAgentImageMode'

export function AgentImageSettings({ mode, busy }: { mode: AgentImageMode; busy: boolean }) {
  const { t } = useTranslation('imageGeneration')
  const fields = useRef<HTMLFieldSetElement>(null)
  useEffect(() => {
    if (mode.template) fields.current?.querySelector<HTMLInputElement>('input, textarea')?.focus()
  }, [mode.template?.id, mode.template?.version])
  const close = () => {
    mode.setConfiguring(false)
    requestAnimationFrame(() => window.dispatchEvent(new Event('kition:agent:focus-composer')))
  }
  return <>
    <div className={cn('agent-image-settings-body', mode.template && 'has-preview')}>
      {mode.template ? <figure className="agent-image-template-preview">
        <img src={mode.template.thumbnail.url} alt={t('templatePreviewAlt', { name: mode.template.title })}
          referrerPolicy="no-referrer" />
        <figcaption className="space-y-2">
          <strong className="block text-sm font-medium">{mode.template.title}</strong>
          <p className="text-xs leading-relaxed text-muted-foreground">{mode.template.description}</p>
        </figcaption>
      </figure> : null}
      <fieldset ref={fields} disabled={busy || mode.preparing} className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-2" data-testid="agent-image-controls">
        {!mode.template ? <p className="text-sm leading-relaxed text-muted-foreground">{t('chat.freeform')}</p> : null}
        {mode.template ? <div className="space-y-3">
          {mode.template.variables.map((variable) => {
            const Control = variable.multiline ? Textarea : Input
            return <label key={variable.key} className="block space-y-1.5">
              <span className="block text-xs font-medium">{variable.label}{variable.required ? ' *' : ''}</span>
              <Control className="agent-image-field" value={mode.variables[variable.key] || ''} required={variable.required}
                maxLength={4000} placeholder={variable.placeholder}
                onChange={(event) => mode.setVariables({ ...mode.variables, [variable.key]: event.target.value })} />
            </label>
          })}
          <div className="flex items-start justify-between gap-2 text-[11px] text-muted-foreground">
            {mode.template.source ? <details className="min-w-0">
              <summary className="cursor-pointer">{t('chat.source')}</summary>
              <p className="mt-1">{mode.template.source.label} · {mode.template.source.license}</p>
              {mode.template.source.url ? <a className="underline" href={mode.template.source.url} target="_blank" rel="noreferrer">{t('chat.source')}</a> : null}
            </details> : <span />}
            <button type="button" className="shrink-0 hover:text-foreground" onClick={() => mode.selectTemplate()}>{t('chat.clearTemplate')}</button>
          </div>
        </div> : null}
        {mode.referencePaths.length ? <div className="space-y-1">
          {mode.referencePaths.map((path) => <div key={path} className="flex min-w-0 items-center justify-between gap-2 text-xs">
            <span className="truncate" title={path}>{path.split('/').pop()}</span>
            <button type="button" className="agent-composer-tool size-7 !p-0" onClick={() => mode.removeReference(path)} aria-label={t('chat.clearReference')}><X className="size-3.5" /></button>
          </div>)}
        </div> : null}
        <div className="grid grid-cols-2 gap-3">
          <Option name="aspect_ratio" values={['1:1', '16:9', '9:16', '4:3', '3:4', '2:3', '3:2']} mode={mode} />
          <Option name="variants" values={['1', '2', '3', '4', '5']} mode={mode} />
        </div>
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer py-1">{t('sections.advanced')}</summary>
          <div className="grid grid-cols-2 gap-3 pt-3">
            <Option name="quality" values={['low', 'medium', 'high']} mode={mode} />
            <Option name="resolution" values={['1K', '2K', '4K']} mode={mode} />
            <Option name="text_mode" values={['baked_text', 'no_text', 'editable_overlay']} mode={mode} />
          </div>
        </details>
        {mode.blockedReason || mode.error ? <p role="status" className="text-xs text-muted-foreground">{mode.error || mode.blockedReason}</p> : null}
      </fieldset>
    </div>
    <div className="agent-image-panel-footer">
      <button type="button" className="agent-composer-tool" onClick={() => { mode.setEnabled(false); close() }}>{t('chat.useChat')}</button>
      <Button size="sm" onClick={close}>{t('chat.done')}</Button>
    </div>
  </>
}

function Option({ name, values, mode }: { name: keyof AgentImageOptions; values: string[]; mode: AgentImageMode }) {
  const { t } = useTranslation('imageGeneration')
  return <label className="block space-y-1.5 text-xs text-foreground">
    <span className="block font-medium">{t(`chat.options.${name}`)}</span>
    <select className="h-9 w-full rounded-lg border border-border bg-background px-2" value={mode.options[name]}
      onChange={(event) => mode.setOptions({ ...mode.options, [name]: name === 'variants' ? Number(event.target.value) : event.target.value })}>
      {values.map((value) => <option key={value} value={value}>{name === 'quality' ? t(`quality.${value as 'low' | 'medium' | 'high'}`) : name === 'text_mode' ? t(`textModes.${value as 'baked_text' | 'no_text' | 'editable_overlay'}.name`) : value}</option>)}
    </select>
  </label>
}
