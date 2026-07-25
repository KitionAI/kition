import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { Check, ChevronDown, Eye, EyeOff } from 'lucide-react'
import { cn } from '../lib/utils'
import { useTranslation } from '@/i18n'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.99] disabled:pointer-events-none',
  {
    variants: {
      variant: {
        // Filled primary CTA. Disabled state uses muted surface tokens
        // rather than a 50% opacity overlay so it stays legible in dark mode
        // (a half-transparent vivid purple over dark page becomes a vague
        // smudge and users can't tell whether the button is just dim or
        // truly disabled).
        default: 'bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none',
        brand: 'bg-brand text-brand-foreground shadow-sm hover:bg-brand/90 active:bg-brand-active disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none',
        secondary: 'border border-input bg-secondary text-secondary-foreground hover:bg-secondary/80 disabled:opacity-50',
        outline: 'border border-input bg-background shadow-sm hover:border-ring/40 hover:bg-accent hover:text-accent-foreground disabled:opacity-50',
        ghost: 'hover:bg-accent hover:text-accent-foreground disabled:opacity-50',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 rounded-lg px-3 text-xs',
        lg: 'h-10 rounded-lg px-5',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants>

export function Button({ className, type = 'button', variant, size, ...props }: ButtonProps) {
  return <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
}

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  // shadow-soft carries the inset-highlight token in dark mode so the card
  // visually lifts off bg-background instead of disappearing into it.
  return <div className={cn('rounded-xl border bg-card text-card-foreground shadow-soft', className)} {...props} />
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex items-center justify-between gap-4 border-b px-4 py-3', className)} {...props} />
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-4', className)} {...props} />
}

export function Badge({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'inline-flex min-h-6 items-center rounded-md border bg-secondary px-2.5 py-0.5 text-xs font-medium text-secondary-foreground',
        className,
      )}
      {...props}
    />
  )
}

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(function Input(props, ref) {
  return (
    <input
      ref={ref}
      {...props}
      className={cn(
        'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none transition-all placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/20',
        props.className,
      )}
    />
  )
})

export const PasswordInput = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(function PasswordInput({ className, ...props }, ref) {
  const { t } = useTranslation('common')
  const [visible, setVisible] = React.useState(false)
  const label = visible ? t('actions.hidePassword') : t('actions.showPassword')
  return (
    <div className="relative">
      <Input
        ref={ref}
        // size=1 stops the native intrinsic width (default ~20ch) from
        // inflating the wrapper's max-content in auto-sized grid/flex tracks,
        // so the field's width is governed by CSS (w-full / min-width) and
        // stays consistent with sibling inputs instead of the icon's extra
        // right padding making it wider.
        size={1}
        {...props}
        type={visible ? 'text' : 'password'}
        className={cn('w-full pr-10', className)}
      />
      <button
        type="button"
        onClick={() => setVisible((prev) => !prev)}
        aria-label={label}
        title={label}
        tabIndex={-1}
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:text-foreground"
      >
        {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  )
})

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea(props, ref) {
  return (
    <textarea
      ref={ref}
      {...props}
      className={cn(
        'min-h-28 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none transition-all placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/20',
        props.className,
      )}
    />
  )
})

type ParsedSelectOption = {
  value: string
  label: React.ReactNode
  labelText: string
  disabled: boolean
}

function extractTextContent(node: React.ReactNode): string {
  return React.Children.toArray(node)
    .map((child) => {
      if (typeof child === 'string' || typeof child === 'number') {
        return String(child)
      }
      if (React.isValidElement<{ children?: React.ReactNode }>(child)) {
        const element = child as React.ReactElement<{ children?: React.ReactNode }>
        return extractTextContent(element.props.children)
      }
      return ''
    })
    .join('')
    .trim()
}

function extractSelectOptions(children: React.ReactNode): ParsedSelectOption[] {
  const options: ParsedSelectOption[] = []

  function visit(node: React.ReactNode) {
    React.Children.forEach(node, (child) => {
      if (!React.isValidElement<{ children?: React.ReactNode }>(child)) {
        return
      }

      const element = child as React.ReactElement<{ children?: React.ReactNode }>

      if (element.type === React.Fragment) {
        visit(element.props.children)
        return
      }

      if (typeof element.type === 'string' && element.type === 'option') {
        const optionProps = element.props as React.OptionHTMLAttributes<HTMLOptionElement>
        const value = optionProps.value === undefined ? extractTextContent(optionProps.children) : String(optionProps.value)
        options.push({
          value,
          label: optionProps.children,
          labelText: extractTextContent(optionProps.children),
          disabled: Boolean(optionProps.disabled),
        })
      }
    })
  }

  visit(children)
  return options
}

function normalizeSelectValue(value: React.SelectHTMLAttributes<HTMLSelectElement>['value'] | React.SelectHTMLAttributes<HTMLSelectElement>['defaultValue']) {
  if (Array.isArray(value)) {
    return value.length ? String(value[0]) : ''
  }
  if (value === undefined || value === null) {
    return ''
  }
  return String(value)
}

export function Select({
  children,
  className,
  defaultValue,
  disabled,
  id,
  name,
  onBlur,
  onChange,
  onFocus,
  title,
  value,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  const options = React.useMemo(() => extractSelectOptions(children), [children])
  const rootRef = React.useRef<HTMLDivElement | null>(null)
  const hiddenSelectRef = React.useRef<HTMLSelectElement | null>(null)
  const passthroughProps = props as Record<string, unknown>
  const dataTestId = typeof passthroughProps['data-testid'] === 'string' ? passthroughProps['data-testid'] : undefined
  const ariaLabel = typeof props['aria-label'] === 'string' ? props['aria-label'] : undefined
  const ariaLabelledBy = typeof props['aria-labelledby'] === 'string' ? props['aria-labelledby'] : undefined
  const isControlled = value !== undefined
  const fallbackValue = React.useMemo(
    () => normalizeSelectValue(defaultValue) || options.find((option) => !option.disabled)?.value || '',
    [defaultValue, options],
  )
  const [open, setOpen] = React.useState(false)
  const [internalValue, setInternalValue] = React.useState(fallbackValue)

  React.useEffect(() => {
    if (isControlled) {
      return
    }

    setInternalValue((current) => current || fallbackValue)
  }, [fallbackValue, isControlled])

  React.useEffect(() => {
    if (!open) {
      return
    }

    function handlePointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }

    window.addEventListener('mousedown', handlePointerDown)
    window.addEventListener('keydown', handleEscape)

    return () => {
      window.removeEventListener('mousedown', handlePointerDown)
      window.removeEventListener('keydown', handleEscape)
    }
  }, [open])

  const selectedValue = isControlled ? normalizeSelectValue(value) : internalValue
  const selectedOption = options.find((option) => option.value === selectedValue) || options[0] || null
  const isPlaceholder = !selectedOption || selectedValue === ''

  function emitChange(nextValue: string) {
    if (!isControlled) {
      setInternalValue(nextValue)
    }

    if (hiddenSelectRef.current) {
      hiddenSelectRef.current.value = nextValue
    }

    onChange?.({
      target: { value: nextValue, name: name || '' },
      currentTarget: { value: nextValue, name: name || '' },
    } as React.ChangeEvent<HTMLSelectElement>)
  }

  function selectOption(nextValue: string) {
    emitChange(nextValue)
    setOpen(false)
  }

  return (
    <div ref={rootRef} className={cn('relative w-full', className)}>
      <button
        type="button"
        id={id}
        name={name}
        title={title}
        disabled={disabled}
        data-testid={dataTestId}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn('el-select', open && 'is-open', disabled && 'is-disabled', isPlaceholder && 'is-placeholder')}
        onClick={() => !disabled && setOpen((current) => !current)}
        onBlur={(event: React.FocusEvent<HTMLButtonElement>) => onBlur?.(event as unknown as React.FocusEvent<HTMLSelectElement>)}
        onFocus={(event: React.FocusEvent<HTMLButtonElement>) => onFocus?.(event as unknown as React.FocusEvent<HTMLSelectElement>)}
      >
        <span className="min-w-0 truncate">{selectedOption?.label || 'Please select'}</span>
        <span className="el-select-chevron">
          <ChevronDown className={cn('size-4 transition-transform duration-200', open && 'rotate-180')} />
        </span>
      </button>

      <select
        {...props}
        ref={hiddenSelectRef}
        id={undefined}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        disabled={disabled}
        value={selectedValue}
        onChange={(event) => selectOption(event.target.value)}
      >
        {options.map((option) => (
          <option key={`${option.value}-${option.labelText}`} value={option.value} disabled={option.disabled}>
            {option.labelText}
          </option>
        ))}
      </select>

      {open ? (
        <div className="el-select-menu" role="listbox" aria-labelledby={id}>
          <div className="el-select-options">
            {options.map((option) => {
              const isSelected = option.value === selectedValue

              return (
                <button
                  key={`${option.value}-${option.labelText}`}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  disabled={option.disabled}
                  className={cn('el-select-option', isSelected && 'is-selected', option.disabled && 'is-disabled')}
                  onClick={() => !option.disabled && selectOption(option.value)}
                >
                  <span className="min-w-0 truncate">{option.label}</span>
                  <span className={cn('el-select-option-check', !isSelected && 'opacity-0')}>
                    <Check className="size-4" />
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      ) : null}
    </div>
  )
}

export function PageHeader({
  kicker,
  title,
  description,
  actions,
}: {
  kicker?: string
  title: string
  description?: string
  actions?: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-4 border-b pb-5 lg:flex-row lg:items-end lg:justify-between">
      <div className="min-w-0">
        {kicker ? <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">{kicker}</p> : null}
        <h1 className="mt-1 text-[1.8rem] font-semibold tracking-tight text-foreground">{title}</h1>
        {description ? <p className="mt-2 max-w-3xl text-sm leading-7 text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2 lg:justify-end">{actions}</div> : null}
    </div>
  )
}

type DisclosureProps = {
  title: string
  defaultOpen?: boolean
  children?: React.ReactNode
  className?: string
  onClose?: () => void
}

export function Disclosure({ title, defaultOpen = false, children, className, onClose }: DisclosureProps) {
  const [open, setOpen] = React.useState(defaultOpen)
  return (
    <div className={cn('disclosure', className)}>
      <button
        type="button"
        className="disclosure-trigger"
        aria-expanded={open}
        onClick={() => {
          const next = !open
          setOpen(next)
          if (!next) onClose?.()
        }}
      >
        <ChevronDown className={cn('size-4 transition-transform', open && 'rotate-180')} />
        <span>{title}</span>
      </button>
      {open ? <div className="disclosure-body">{children}</div> : null}
    </div>
  )
}
