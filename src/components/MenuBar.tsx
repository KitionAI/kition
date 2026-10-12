import { Menubar as MenubarPrimitive } from 'radix-ui'
import { ChevronRight } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'

import { cn } from '@/lib/utils'

/**
 * An application menu bar (File, Edit, ...) with keyboard navigation and
 * submenus, styled like the rest of Kition's menus.
 */
export const MenuBarMenu = MenubarPrimitive.Menu
export const MenuBarSub = MenubarPrimitive.Sub

const contentClass = 'z-50 min-w-56 max-h-[70vh] overflow-y-auto rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-[var(--shadow-floating)] outline-none'
const itemClass = 'flex h-8 cursor-default select-none items-center gap-2 rounded-md px-2 text-sm outline-none data-[disabled]:text-muted-foreground data-[highlighted]:bg-muted data-[highlighted]:text-foreground data-[state=open]:bg-muted'

export function MenuBar({ className, ...props }: ComponentProps<typeof MenubarPrimitive.Root>) {
  return <MenubarPrimitive.Root className={cn('flex items-center gap-0.5', className)} {...props} />
}

export function MenuBarTrigger({ className, ...props }: ComponentProps<typeof MenubarPrimitive.Trigger>) {
  return (
    <MenubarPrimitive.Trigger
      className={cn('h-7 rounded-md px-2.5 text-[13px] font-medium text-foreground outline-none data-[highlighted]:bg-muted data-[state=open]:bg-muted', className)}
      {...props}
    />
  )
}

export function MenuBarContent({ className, align = 'start', sideOffset = 4, ...props }: ComponentProps<typeof MenubarPrimitive.Content>) {
  return (
    <MenubarPrimitive.Portal>
      <MenubarPrimitive.Content className={cn(contentClass, className)} align={align} sideOffset={sideOffset} {...props} />
    </MenubarPrimitive.Portal>
  )
}

export function MenuBarItem({ className, shortcut, children, ...props }: ComponentProps<typeof MenubarPrimitive.Item> & { shortcut?: string }) {
  return (
    <MenubarPrimitive.Item className={cn(itemClass, className)} {...props}>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut ? <span className="shrink-0 text-xs text-muted-foreground">{shortcut}</span> : null}
    </MenubarPrimitive.Item>
  )
}

export function MenuBarSeparator({ className, ...props }: ComponentProps<typeof MenubarPrimitive.Separator>) {
  return <MenubarPrimitive.Separator className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />
}

export function MenuBarSubTrigger({ className, children, ...props }: ComponentProps<typeof MenubarPrimitive.SubTrigger> & { children: ReactNode }) {
  return (
    <MenubarPrimitive.SubTrigger className={cn(itemClass, className)} {...props}>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
    </MenubarPrimitive.SubTrigger>
  )
}

export function MenuBarSubContent({ className, sideOffset = 6, ...props }: ComponentProps<typeof MenubarPrimitive.SubContent>) {
  return (
    <MenubarPrimitive.Portal>
      <MenubarPrimitive.SubContent className={cn(contentClass, className)} sideOffset={sideOffset} {...props} />
    </MenubarPrimitive.Portal>
  )
}
