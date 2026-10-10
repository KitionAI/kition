import { useTranslation } from 'react-i18next'
import type { KitsCommandView } from '@/api/kits'
import { KitMenuBar } from '@/features/kits/public'
import { PHOTO_MENU_ORDER } from './photoTools'

type PhotoMenuBarProps = {
  commands: readonly KitsCommandView[]
  onRun: (command: KitsCommandView) => void
  onOpen: () => void
}

/** Photo's menus, in the order desktop image editors show them. */
export function PhotoMenuBar({ commands, onRun, onOpen }: PhotoMenuBarProps) {
  const { t } = useTranslation('workspace')
  return (
    <KitMenuBar
      commands={commands}
      onRun={onRun}
      onOpen={onOpen}
      order={PHOTO_MENU_ORDER}
      menuLabel={(label) => t(`photoKit.menu.${label}`, { defaultValue: label })}
      testId="photo-menu"
    />
  )
}
