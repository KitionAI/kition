import { ExtensionPanelSlot } from '@/features/extensions/public'
import { KitFrame } from '@/features/kits/public'
import type { KitEditorEntry, KitEditorProps } from './kitEditors'
import { KITION_LINK_OPENER, openKitLink } from './kitLinks'

/** A file a kit of this build opens, in the kit's own editor. */
export function KitFilePane({ kit, ...props }: KitEditorProps & { kit: KitEditorEntry }) {
  // An extension's panel, when one is open for this document, sits to the right of the editor.
  return (
    <div className="flex h-full min-h-0">
      <div className="h-full min-w-0 flex-1">
        <KitFrame kit={kit.embedded} {...props} onOpenLink={(params) => openKitLink(props.path, params, KITION_LINK_OPENER)} />
      </div>
      <ExtensionPanelSlot path={props.path} />
    </div>
  )
}
