import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { KitIcon } from '@/components/KitIcon'
import { ExtensionPanelSlot } from '@/features/extensions/public'
import { KitFrame } from '@/features/kits/public'
import { kitAvailable, type KitEditorEntry, type KitEditorProps } from './kitEditors'

/**
 * A file a kit opens, in the kit's own editor. Release builds include every kit; a development
 * build without the kit's package shows the file preview for formats it shows, or says so.
 */
export function KitFilePane({ kit, preview, ...props }: KitEditorProps & { kit: KitEditorEntry; preview: ReactNode }) {
  const [available, setAvailable] = useState<boolean | null>(null)

  useEffect(() => {
    let current = true
    void kitAvailable(kit).then((yes) => {
      if (current) setAvailable(yes)
    })
    return () => {
      current = false
    }
  }, [kit])

  if (available == null) return null
  if (available) {
    // An extension's panel, when one is open for this document, sits to the right of the editor.
    return (
      <div className="flex h-full min-h-0">
        <div className="h-full min-w-0 flex-1">
          <KitFrame kit={kit.embedded} {...props} />
        </div>
        <ExtensionPanelSlot path={props.path} />
      </div>
    )
  }
  return kit.preview ? preview : <KitUnavailable kit={kit} />
}

function KitUnavailable({ kit }: { kit: KitEditorEntry }) {
  const { t } = useTranslation('workspace')
  return (
    <div className="flex h-full items-center justify-center p-8" data-testid={`${kit.key}-unavailable`}>
      <div className="max-w-md rounded-xl border border-border bg-background p-6 text-center">
        <KitIcon kit={kit.icon} className="mx-auto mb-3 size-8" />
        <p className="text-[15px] font-semibold text-foreground">{t(`${kit.key}Kit.unavailableTitle`)}</p>
        <p className="mt-2 text-[13px] text-muted-foreground">{t(`${kit.key}Kit.unavailableBody`)}</p>
      </div>
    </div>
  )
}
