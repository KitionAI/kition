'use client'

import { Switch as SwitchPrimitive } from 'radix-ui'
import * as React from 'react'

import { cn } from '@/lib/utils'

export type SwitchProps = React.ComponentProps<typeof SwitchPrimitive.Root>

/**
 * Tailwind-styled wrapper over radix-ui's Switch primitive.
 * Compact 28x16 control for field-editor toggles.
 */
export const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitive.Root>,
  SwitchProps
>(function Switch({ className, ...props }, ref) {
  return (
    <SwitchPrimitive.Root
      ref={ref}
      className={cn(
        'peer relative inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full border border-transparent',
        'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'data-[state=checked]:bg-foreground data-[state=unchecked]:bg-input',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          'pointer-events-none block size-3 rounded-full bg-background shadow-sm ring-0 transition-transform',
          // In dark mode `bg-background` is darker than `bg-input`, which
          // makes the off-state thumb visually disappear into the track.
          // Brighten the off-state thumb so the toggle stays scannable.
          'dark:data-[state=unchecked]:bg-muted-foreground/80 dark:data-[state=checked]:bg-background',
          'data-[state=checked]:translate-x-3 data-[state=unchecked]:translate-x-0.5',
        )}
      />
    </SwitchPrimitive.Root>
  )
})
