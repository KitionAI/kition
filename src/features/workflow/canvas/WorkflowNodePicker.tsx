import { Bot, Braces, Database, FilePenLine, Filter, Mail, Search, Sparkles, WandSparkles, Webhook, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

export type InsertableActionType = 'send_email' | 'add_record' | 'update_record' | 'lookup_record' | 'transform_record'

type Tab = 'common' | 'ai' | 'connectors' | 'utilities'
type NodeItem = {
  id: InsertableActionType | string
  tab: Tab
  labelKey: string
  descriptionKey: string
  enabled: boolean
  icon: typeof Database
}

const items: NodeItem[] = [
  { id: 'update_record', tab: 'common', labelKey: 'updateRecord', descriptionKey: 'updateRecordDesc', enabled: true, icon: FilePenLine },
  { id: 'lookup_record', tab: 'common', labelKey: 'lookupRecord', descriptionKey: 'lookupRecordDesc', enabled: true, icon: Search },
  { id: 'add_record', tab: 'common', labelKey: 'addRecord', descriptionKey: 'addRecordDesc', enabled: true, icon: Database },
  { id: 'transform_record', tab: 'utilities', labelKey: 'transformRecord', descriptionKey: 'transformRecordDesc', enabled: true, icon: WandSparkles },
  { id: 'send_email', tab: 'connectors', labelKey: 'sendEmail', descriptionKey: 'sendEmailDesc', enabled: true, icon: Mail },
  { id: 'if_else', tab: 'common', labelKey: 'ifElse', descriptionKey: 'ifElseDesc', enabled: false, icon: Filter },
  { id: 'ai_text', tab: 'ai', labelKey: 'aiText', descriptionKey: 'aiTextDesc', enabled: false, icon: Sparkles },
  { id: 'ai_classify', tab: 'ai', labelKey: 'aiClassify', descriptionKey: 'aiClassifyDesc', enabled: false, icon: Bot },
  { id: 'webhook', tab: 'connectors', labelKey: 'webhook', descriptionKey: 'webhookDesc', enabled: false, icon: Webhook },
  { id: 'javascript', tab: 'utilities', labelKey: 'javascript', descriptionKey: 'javascriptDesc', enabled: false, icon: Braces },
]

export function WorkflowNodePicker({ onPick, onClose }: { onPick: (type: InsertableActionType) => void; onClose: () => void }) {
  const { t } = useTranslation('workflow')
  const [tab, setTab] = useState<Tab>('common')
  const [query, setQuery] = useState('')
  const pickerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (!pickerRef.current?.contains(event.target as Node)) onClose()
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return items.filter((item) => {
      if (!needle && item.tab !== tab) return false
      if (!needle) return true
      return `${t(`nodePicker.items.${item.labelKey}`)} ${t(`nodePicker.items.${item.descriptionKey}`)}`.toLocaleLowerCase().includes(needle)
    })
  }, [query, tab, t])

  return createPortal(
    <div ref={pickerRef} className="fixed left-1/2 top-1/2 z-[80] flex h-[min(500px,calc(100vh-32px))] w-[min(560px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-floating" data-testid="workflow-node-picker" role="dialog" aria-label={t('nodePicker.search')}>
      <div className="flex h-14 items-center gap-3 border-b border-border px-4">
        <Search className="size-5 text-muted-foreground" />
        <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('nodePicker.search')} className="h-full min-w-0 flex-1 border-0 bg-transparent text-sm outline-none" />
        <button type="button" onClick={onClose} className="inline-grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground" title={t('nodePicker.close')} aria-label={t('nodePicker.close')}>
          <X className="size-4" />
        </button>
      </div>
      <div className="flex h-12 items-end gap-1 border-b border-border px-4">
        {(['common', 'ai', 'connectors', 'utilities'] as Tab[]).map((value) => (
          <button key={value} type="button" data-picker-tab={value} onClick={() => { setTab(value); setQuery('') }} className={`h-full border-b-2 px-3 text-sm ${tab === value && !query ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
            {t(`nodePicker.tabs.${value}`)}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="mb-2 px-2 text-xs font-medium text-muted-foreground">{query ? t('nodePicker.results') : t(`nodePicker.tabs.${tab}`)}</div>
        <div className="grid gap-1">
          {visible.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                type="button"
                disabled={!item.enabled}
                onClick={() => { if (item.enabled) onPick(item.id as InsertableActionType) }}
                className="group flex min-h-14 items-center gap-3 rounded-lg px-3 text-left hover:bg-muted disabled:cursor-not-allowed disabled:opacity-55"
                data-node-type={item.id}
              >
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/15 text-primary"><Icon className="size-4" /></span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{t(`nodePicker.items.${item.labelKey}`)}</span>
                  <span className="block truncate text-xs text-muted-foreground">{t(`nodePicker.items.${item.descriptionKey}`)}</span>
                </span>
                {!item.enabled ? <span className="rounded-md bg-muted px-2 py-1 text-[10px] text-muted-foreground">{t('nodePicker.planned')}</span> : null}
              </button>
            )
          })}
        </div>
      </div>
    </div>,
    document.body,
  )
}
