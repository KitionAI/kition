'use client';

import { Dialog as DialogPrimitive } from 'radix-ui';

type DialogPrimitiveProps = React.ComponentProps<typeof DialogPrimitive.Root>;

import { cva, type VariantProps } from 'class-variance-authority';
import { createAtomStore } from 'jotai-x';
import { XIcon } from 'lucide-react';
import type { ComponentProps } from 'react';
import * as React from 'react';
import { Drawer as DrawerPrimitive } from 'vaul';

import { cn } from '@/lib/utils';
import { useMediaQuery } from '@/registry/hooks/use-media-query';
import { useMounted } from '@/registry/hooks/use-mounted';
import { buttonVariants } from '@/registry/ui/button';

const useIsDesktop = () => {
  const mounted = useMounted();

  return useMediaQuery('(min-width: 768px)') || !mounted;
};

/** Dialog */

export type DialogProps = DialogPrimitiveProps;

export const DialogModal = DialogPrimitive.Root;

export const DialogModalTrigger = DialogPrimitive.Trigger;

export const DialogPortal = DialogPrimitive.Portal;

export function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      className={cn(
        'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/40 data-[state=closed]:animate-out data-[state=open]:animate-in print:hidden',
        className
      )}
      {...props}
    />
  );
}

export const DialogClosePrimitive = DialogPrimitive.Close;

export function DialogClose({
  children,
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return (
    <DialogPrimitive.Close
      aria-label="Close"
      className={cn(
        buttonVariants({ size: 'none', variant: 'ghost' }),
        'top-2.5 right-2.5 size-6',
        'focus:focus-ring absolute z-20 rounded-full bg-muted opacity-70 ring-offset-background transition-opacity hover:bg-primary/10 hover:opacity-100 focus:outline-none disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-subtle-foreground',
        className
      )}
      {...props}
    >
      <XIcon className="!size-3.5 text-muted-foreground" />
    </DialogPrimitive.Close>
  );
}

const dialogContentVariants = cva(
  cn(
    '-translate-x-1/2 -translate-y-1/2 fixed top-1/2 left-1/2 z-[101] flex w-full flex-col border bg-background shadow-black/5 shadow-lg focus-visible:ring-0'
  ),
  {
    defaultVariants: {
      minHeight: false,
      size: 'lg',
      variant: 'modal',
    },
    variants: {
      minHeight: {
        false: '',
        true: 'min-h-[640px]',
      },
      size: {
        '2xl': 'md:max-w-2xl',
        '3xl': 'md:max-w-3xl',
        '4xl': 'md:max-w-4xl',
        lg: 'md:max-w-lg',
        md: 'md:max-w-md',
        none: '',
        sm: 'md:max-w-sm',
        xl: 'md:max-w-xl',
        xs: 'md:max-w-xs',
      },
      variant: {
        full: cn(
          'h-full max-w-full',
          'data-[state=closed]:slide-out-to-bottom data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:animate-out data-[state=closed]:duration-500'
        ),
        modal: cn(
          'sm:rounded-lg md:w-full',
          'data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 duration-200 data-[state=closed]:animate-out data-[state=open]:animate-in',
          'max-w-[calc(100%-2rem)]'
        ),
      },
    },
  }
);

function DialogModalContent({
  as: Component = DialogPrimitive.Content,
  children,
  className,
  disableAutoFocus,
  dismissible = true,
  hideClose,
  minHeight,
  size,
  variant: variantProp = 'modal',
  onPointerDownOutside,
  ...props
}: {
  as?: React.FC<ComponentProps<typeof DialogPrimitive.Content>>;
  disableAutoFocus?: boolean;
  dismissible?: boolean;
  fixed?: boolean;
  hideClose?: boolean;
} & VariantProps<typeof dialogContentVariants> &
  React.ComponentProps<typeof DialogPrimitive.Content>) {
  let variant = useDialogValue('variant') as any;
  variant = variant === 'modal' ? variantProp! : variant;
  const fixed = useDialogContentValue('fixed');

  return (
    <DialogPortal>
      <DialogOverlay />
      <Component
        className={cn(
          dialogContentVariants({ minHeight, size, variant }),
          fixed ? 'gap-0 p-0 sm:max-h-[min(640px,80vh)]' : 'gap-4 p-6',
          className
        )}
        onOpenAutoFocus={(e) => {
          if (disableAutoFocus) {
            e.preventDefault();
          }
        }}
        onPointerDownOutside={(e) => {
          if (!dismissible) {
            e.preventDefault();
          }

          onPointerDownOutside?.(e);
        }}
        {...props}
      >
        {children}

        {!hideClose && variant !== 'drawer' && <DialogClose />}
      </Component>
    </DialogPortal>
  );
}

export function DialogHeader({
  className,
  ...props
}: React.ComponentProps<'div'>) {
  const variant = useDialogValue('variant');
  const fixed = useDialogContentValue('fixed');

  return (
    <div
      className={cn(
        'flex flex-col space-y-1.5 text-left',
        fixed && 'space-y-0 border-border border-b p-4',
        variant === 'drawer' && 'px-4 pt-4',
        className
      )}
      {...props}
    />
  );
}

export function DialogFooter({
  className,
  ...props
}: React.ComponentProps<'div'>) {
  const variant = useDialogValue('variant');
  const fixed = useDialogContentValue('fixed');

  return (
    <div
      className={cn(
        'flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2',
        'max-md:[&_button]:w-full',
        fixed && 'border-border border-t p-4',
        variant === 'drawer' && 'p-4',
        className
      )}
      {...props}
    />
  );
}

export function DialogModalTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn(
        'font-semibold text-lg md:text-xl md:tracking-tight',
        className
      )}
      {...props}
    />
  );
}

export function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cn('text-sm text-subtle-foreground', className)}
      {...props}
    />
  );
}

export const { DialogProvider, useDialogSet, useDialogStore, useDialogValue } =
  createAtomStore(
    {
      desktopVariant: 'modal' as 'drawer' | 'full' | 'modal',
      dismissible: true,
      mobileVariant: 'drawer' as 'drawer' | 'full' | 'modal',
      variant: 'modal' as 'drawer' | 'full' | 'modal',
    },
    { name: 'dialog' }
  );

export const { DialogContentProvider, useDialogContentValue } = createAtomStore(
  { fixed: false },
  { name: 'dialogContent' }
);

export function Dialog({
  desktopVariant = 'modal',
  mobileVariant = 'drawer',
  ...props
}: ComponentProps<typeof DialogProvider> & DialogProps) {
  const isDesktop = useIsDesktop();

  const variant = isDesktop ? desktopVariant : mobileVariant;

  const ResponsiveDialog = variant === 'drawer' ? Drawer : DialogModal;

  return (
    <DialogProvider variant={variant}>
      <ResponsiveDialog {...props} {...(!isDesktop && { autoFocus: true })} />
    </DialogProvider>
  );
}

export function DialogTrigger(
  props: React.ComponentProps<typeof DialogModalTrigger>
) {
  const variant = useDialogValue('variant');
  const ResponsiveTrigger =
    variant === 'drawer' ? DrawerTrigger : DialogModalTrigger;

  return <ResponsiveTrigger {...props} />;
}

export function DialogContent({
  as,
  disableAutoFocus,
  fixed,
  hideClose,
  size,
  ...props
}: React.ComponentProps<typeof DialogModalContent> & { fixed?: boolean }) {
  const variant = useDialogValue('variant');
  const dismissible = useDialogValue('dismissible');

  return (
    <DialogContentProvider fixed={fixed}>
      {variant === 'drawer' ? (
        <DrawerContent dismissible={dismissible} {...(props as any)} />
      ) : (
        <DialogModalContent
          as={as}
          disableAutoFocus={disableAutoFocus}
          dismissible={dismissible}
          hideClose={hideClose}
          size={size}
          {...props}
        />
      )}
    </DialogContentProvider>
  );
}

export function DialogBody({
  children,
  className,
  ...props
}: React.ComponentProps<'div'>) {
  const fixed = useDialogContentValue('fixed');
  const variant = useDialogValue('variant');

  return (
    <div
      className={cn(
        'flex w-full flex-col gap-4',
        fixed && 'grow overflow-y-auto p-4',
        variant === 'drawer' && 'p-4',
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function DialogTitle(
  props: React.ComponentProps<typeof DialogModalTitle>
) {
  const variant = useDialogValue('variant');

  return variant === 'drawer' ? (
    <DrawerTitle {...props} />
  ) : (
    <DialogModalTitle {...props} />
  );
}

/** Drawer */

export function Drawer(
  props: React.ComponentProps<typeof DrawerPrimitive.Root>
) {
  return <DrawerPrimitive.Root shouldScaleBackground={false} {...props} />;
}

export const DrawerTrigger = DrawerPrimitive.Trigger;

export const DrawerPortal = DrawerPrimitive.Portal;

export const DrawerClose = DrawerPrimitive.Close;

export function DrawerOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Overlay>) {
  return (
    <DrawerPrimitive.Overlay
      className={cn('fixed inset-0 z-50 bg-black/40', className)}
      {...props}
    />
  );
}

export function DrawerContent({
  children,
  className,
  dismissible = true,
  onPointerDownOutside,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Content> & {
  dismissible?: boolean;
}) {
  return (
    <DrawerPortal>
      <DrawerOverlay />

      <DrawerPrimitive.Content
        className={cn(
          'fixed inset-x-0 bottom-0 z-50 mt-24 flex h-auto max-h-[80dvh] w-full flex-col rounded-t-[10px] bg-background py-4 focus-visible:ring-0',
          className
        )}
        onPointerDownOutside={(e) => {
          if (!dismissible) {
            e.preventDefault();
          }

          onPointerDownOutside?.(e);
        }}
        {...props}
      >
        {children}
      </DrawerPrimitive.Content>
    </DrawerPortal>
  );
}

export const DrawerFooter = DialogFooter;

export const DrawerHeader = DialogHeader;

export function DrawerTitle({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Title>) {
  return (
    <DrawerPrimitive.Title
      className={cn(
        'font-semibold text-lg md:text-xl md:tracking-tight',
        className
      )}
      {...props}
    />
  );
}

export function DrawerDescription({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Description>) {
  return (
    <DrawerPrimitive.Description
      className={cn('text-sm text-subtle-foreground', className)}
      {...props}
    />
  );
}
