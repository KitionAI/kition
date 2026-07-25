'use client';

import { cva, type VariantProps } from 'class-variance-authority';
import { Popover as PopoverPrimitive } from 'radix-ui';
import * as React from 'react';

import { cn } from '@/lib/utils';

const popoverVariants = cva(
  cn(
    'group/popover',
    'z-50 max-w-[calc(100vw-24px)] animate-popover overflow-hidden rounded-md bg-popover text-popover-foreground shadow-floating outline-none'
  ),
  {
    defaultVariants: {
      variant: 'default',
    },
    variants: {
      variant: {
        combobox: '',
        default: 'w-72',
        equation: 'w-[400px] rounded-lg px-2.5 py-2',
        equationInline: 'w-[400px] rounded-lg px-2.5 py-2',
        media: 'max-h-[70vh] min-w-[180px] rounded-lg',
      },
    },
  }
);

function Popover({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverAnchor({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />;
}

function PopoverContent({
  align = 'center',
  className,
  sideOffset = 4,
  variant,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content> &
  VariantProps<typeof popoverVariants>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        className={cn(popoverVariants({ variant }), className)}
        data-slot="popover-content"
        sideOffset={sideOffset}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

export {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
  popoverVariants,
};
