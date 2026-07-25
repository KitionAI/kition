'use client';

import { Slot } from 'radix-ui';

const SlotRoot = Slot.Root;

import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import * as React from 'react';

import { cn } from '@/lib/utils';

import { Spinner } from './spinner';
import { withTooltip } from './tooltip';

export const buttonVariants = cva(
  'focus-ring inline-flex w-fit cursor-pointer select-none items-center justify-center gap-2 rounded-md text-sm ring-offset-background transition-[background-color,border-color,color,fill,stroke,box-shadow,transform] duration-fast ease-standard active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    defaultVariants: {
      size: 'default',
      truncate: true,
      variant: 'default',
    },
    variants: {
      active: {
        false: '',
        true: 'border-2 border-primary',
      },
      disabled: {
        true: 'pointer-events-none opacity-50',
      },
      focused: {
        true: 'ring-2 ring-ring ring-offset-2',
      },
      isMenu: {
        true: 'h-auto w-full cursor-pointer justify-start',
      },
      size: {
        blockAction: 'size-[26px] gap-1 px-1.5 text-xs',
        default: 'h-[28px] gap-1.5 px-2',
        icon: 'size-[28px] w-[33px] [&_svg]:size-5',
        iconSm: 'size-[28px]',
        lg: 'h-11 px-4 text-lg',
        md: 'h-8 px-3',
        menuAction: 'size-6',
        navAction: 'size-5',
        none: '',
        xs: 'h-[26px] px-1.5 py-1 text-xs',
      },
      truncate: {
        true: 'truncate whitespace-nowrap',
      },
      variant: {
        blockAction:
          'rounded-sm hover:bg-primary/6 [&_svg]:text-muted-foreground',
        blockActionSecondary:
          'rounded-sm bg-primary/6 [&_svg]:text-muted-foreground',
        brand:
          'bg-brand font-medium text-white hover:bg-brand/80 active:bg-brand-active',
        default:
          'bg-primary font-medium text-primary-foreground hover:bg-primary/90 [&_svg]:text-primary-foreground',
        destructive:
          'bg-destructive text-destructive-foreground hover:bg-destructive/90 [&_svg]:text-destructive-foreground',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        ghost2: 'text-muted-foreground hover:bg-accent',
        ghost3: 'text-muted-foreground/80 hover:bg-accent',
        ghostActive: 'bg-accent hover:bg-accent hover:text-accent-foreground',
        menuAction: 'text-muted-foreground/80 hover:bg-primary/6',
        nav: 'rounded-sm text-muted-foreground transition hover:bg-primary/4',
        navAction:
          'rounded-sm text-muted-foreground/80 opacity-0 transition hover:bg-primary/6 group-hover:opacity-100',
        none: '',
        outline:
          'border border-input bg-background hover:bg-accent hover:text-accent-foreground',
        primaryOutline:
          'border border-primary-foreground text-primary-foreground hover:bg-accent/15 [&_svg]:text-primary-foreground',
        radio: 'border-2 border-input hover:border-primary',
        secondary:
          'bg-secondary text-secondary-foreground hover:bg-secondary/80',
      },
    },
  }
);

export type ButtonExtendedProps = {
  active?: boolean;
  asChild?: boolean;
  icon?: React.ReactNode;
  iconPlacement?: 'left' | 'right';
  isPending?: boolean;
  loading?: boolean;
  loadingClassName?: string;
  onToggleClick?: () => void;
} & {
  children?: React.ReactNode;
  label?: string;
} & VariantProps<typeof buttonVariants>;

export type ButtonProps = ComponentProps<typeof Button>;

export const Button = withTooltip(function Button({
  active,
  asChild = false,
  children,
  className,
  focused,
  icon,
  iconPlacement = 'left',
  isMenu,
  isPending,
  label,
  loading,
  loadingClassName,
  size,
  truncate,
  variant,
  onToggleClick,
  ...props
}: ButtonExtendedProps & React.ComponentProps<'button'>) {
  const Comp = asChild ? SlotRoot : 'button';

  return (
    <Comp
      aria-label={label && label.length > 0 ? label : undefined}
      className={cn(
        buttonVariants({
          disabled: props.disabled,
          focused,
          isMenu,
          size,
          truncate,
          variant,
        }),
        active && 'border-2 border-primary',
        className
      )}
      type={Comp === 'button' ? 'button' : undefined}
      {...props}
    >
      {icon && iconPlacement === 'left' && icon}
      {loading && <Spinner className={loadingClassName} />}
      {children}
      {icon && iconPlacement === 'right' && icon}
    </Comp>
  );
});

export type LinkButtonProps = ComponentProps<typeof LinkButton>;

export const LinkButton = withTooltip(function LinkButton({
  active,
  children,
  className,
  focused,
  icon,
  iconPlacement = 'left',
  isMenu,
  label,
  loading,
  loadingClassName,
  size,
  truncate,
  variant = 'ghost',
  ...props
}: ButtonExtendedProps & React.ComponentProps<'a'>) {
  return (
    <a
      aria-label={label && label.length > 0 ? label : undefined}
      className={cn(
        buttonVariants({
          disabled: props.disabled,
          focused,
          isMenu,
          size,
          truncate,
          variant,
        }),
        active && 'border-2 border-primary',
        className
      )}
      role="button"
      {...props}
    >
      {icon && iconPlacement === 'left' && (
        <div className="shrink-0">{icon}</div>
      )}
      {loading && <Spinner className={loadingClassName} />}
      {children}
      {icon && iconPlacement === 'right' && icon}
    </a>
  );
});
