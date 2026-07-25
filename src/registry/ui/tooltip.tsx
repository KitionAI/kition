'use client';

import { Tooltip as TooltipPrimitive } from 'radix-ui';
import * as React from 'react';

import { cn } from '@/lib/utils';
import { useMounted } from '@/registry/hooks/use-mounted';

export function TooltipProvider({
  delayDuration = 200,
  disableHoverableContent = true,
  skipDelayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      delayDuration={delayDuration}
      disableHoverableContent={disableHoverableContent}
      skipDelayDuration={skipDelayDuration}
      {...props}
    />
  );
}

export const Tooltip = TooltipPrimitive.Root;

export const TooltipTrigger = TooltipPrimitive.Trigger;

export const TooltipPortal = TooltipPrimitive.Portal;

export function TooltipContent({
  className,
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Content
      className={cn(
        'z-9999 overflow-hidden rounded-md bg-primary px-2 py-1.5 font-semibold text-primary-foreground text-xs shadow-md',
        className
      )}
      sideOffset={sideOffset}
      {...props}
    />
  );
}

export function TooltipTC({
  children,
  className,
  content,
  defaultOpen,
  delayDuration,
  disableHoverableContent,
  open,
  onOpenChange,
  ...props
}: {
  content: React.ReactNode;
} & React.ComponentProps<typeof TooltipPrimitive.Content> &
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Root>) {
  const mounted = useMounted();

  if (!mounted) {
    return children;
  }

  return (
    <TooltipProvider>
      <Tooltip
        defaultOpen={defaultOpen}
        delayDuration={delayDuration}
        disableHoverableContent={disableHoverableContent}
        onOpenChange={onOpenChange}
        open={open}
      >
        <TooltipTrigger asChild>{children}</TooltipTrigger>

        <TooltipPortal>
          <TooltipContent className={className} {...props}>
            {content}
          </TooltipContent>
        </TooltipPortal>
      </Tooltip>
    </TooltipProvider>
  );
}

type TooltipProps<T extends React.ElementType> = {
  shortcut?: React.ReactNode;
  tooltip?: React.ReactNode;
  tooltipContentProps?: Omit<
    React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>,
    'children'
  >;
  tooltipProps?: Omit<
    React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Root>,
    'children'
  >;
  tooltipTriggerProps?: React.ComponentPropsWithoutRef<
    typeof TooltipPrimitive.Trigger
  >;
} & React.ComponentProps<T>;

export function withTooltip<T extends React.ElementType>(Component: T) {
  return function ExtendComponent({
    shortcut,
    tooltip,
    tooltipContentProps,
    tooltipProps,
    tooltipTriggerProps,
    ...props
  }: TooltipProps<T>) {
    const isMounted = useMounted();

    const component = <Component {...(props as React.ComponentProps<T>)} />;

    if (tooltip && isMounted) {
      return (
        <TooltipProvider>
          <Tooltip {...tooltipProps}>
            <TooltipTrigger asChild {...tooltipTriggerProps}>
              {component}
            </TooltipTrigger>

            <TooltipPortal>
              <TooltipContent {...tooltipContentProps}>
                {tooltip}
                {shortcut && (
                  <div className="mt-px text-subtle-foreground">{shortcut}</div>
                )}
              </TooltipContent>
            </TooltipPortal>
          </Tooltip>
        </TooltipProvider>
      );
    }

    return component;
  };
}
