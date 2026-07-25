import {
  forwardRef,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { CalendarDays, ChevronLeft, ChevronRight, Clock3 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { getCurrentLocale } from '@/i18n'
import { cn } from '@/lib/utils'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/registry/ui/popover'
import { toDateInputValue } from '@/features/table/lib/dateFormatting'

type PickerType = 'date' | 'time' | null

type TableDateCellEditorProps = {
  active: boolean
  inputType: 'date' | 'datetime-local'
  value: string
  style?: CSSProperties
  onValueChange: (next: string) => void
  onCommit: (next: string) => void
}

const HALF_HOUR_TIMES = Array.from({ length: 48 }, (_, index) => {
  const hours = Math.floor(index / 2)
  const minutes = index % 2 === 0 ? '00' : '30'
  return `${String(hours).padStart(2, '0')}:${minutes}`
})

function parseEditorDate(value: string): Date | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (dateMatch) {
    const date = new Date(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]))
    return Number.isNaN(date.getTime()) ? null : date
  }

  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function isSameDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate()
}

function calendarCells(viewDate: Date): Date[] {
  const first = new Date(viewDate.getFullYear(), viewDate.getMonth(), 1)
  const start = new Date(first)
  start.setDate(first.getDate() - first.getDay())

  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start)
    date.setDate(start.getDate() + index)
    return date
  })
}

function editorValueFromDate(inputType: 'date' | 'datetime-local', date: Date): string {
  return toDateInputValue(inputType, date.toISOString())
}

export const TableDateCellEditor = forwardRef<HTMLDivElement, TableDateCellEditorProps>(
  function TableDateCellEditor({
    active,
    inputType,
    value,
    style,
    onValueChange,
    onCommit,
  }, ref) {
    const { t } = useTranslation('table')
    const selectedDate = useMemo(() => parseEditorDate(value), [value])
    const today = useMemo(() => new Date(), [])
    const [picker, setPicker] = useState<PickerType>(null)
    const [viewDate, setViewDate] = useState(() => selectedDate ?? today)
    const selectedTimeRef = useRef<HTMLButtonElement | null>(null)

    useEffect(() => {
      if (!active) {
        setPicker(null)
        return
      }
      setViewDate(selectedDate ?? today)
      setPicker('date')
    }, [active, selectedDate, today])

    useEffect(() => {
      if (picker !== 'time') return
      selectedTimeRef.current?.scrollIntoView?.({ block: 'center' })
    }, [picker])

    const weekdays = useMemo(() => Array.from({ length: 7 }, (_, index) => {
      const date = new Date(2026, 0, 4 + index)
      return new Intl.DateTimeFormat(getCurrentLocale(), { weekday: 'narrow' }).format(date)
    }), [])

    const monthLabel = useMemo(() => new Intl.DateTimeFormat(getCurrentLocale(), {
      year: 'numeric',
      month: 'long',
    }).format(viewDate), [viewDate])

    const cells = useMemo(() => calendarCells(viewDate), [viewDate])
    const datePart = value.slice(0, 10)
    const timePart = value.includes('T') ? value.slice(11, 16) : ''
    const timeOptions = useMemo(() => {
      if (!timePart || HALF_HOUR_TIMES.includes(timePart)) return HALF_HOUR_TIMES
      return [...HALF_HOUR_TIMES, timePart].sort()
    }, [timePart])

    function commit(next: string) {
      onValueChange(next)
      onCommit(next)
      setPicker(null)
    }

    function chooseDate(date: Date) {
      const base = selectedDate ?? today
      const next = new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate(),
        inputType === 'datetime-local' ? base.getHours() : 0,
        inputType === 'datetime-local' ? base.getMinutes() : 0,
        inputType === 'datetime-local' ? base.getSeconds() : 0,
      )
      commit(editorValueFromDate(inputType, next))
    }

    function chooseTime(time: string) {
      const base = selectedDate ?? today
      const [hours, minutes] = time.split(':').map(Number)
      const next = new Date(base)
      next.setHours(hours, minutes, 0, 0)
      commit(editorValueFromDate('datetime-local', next))
    }

    function moveMonth(offset: number) {
      setViewDate((current) => new Date(current.getFullYear(), current.getMonth() + offset, 1))
    }

    return (
      <div
        ref={ref}
        tabIndex={-1}
        style={style}
        data-testid="table-date-cell-editor"
        className="flex items-center overflow-hidden rounded-md bg-background text-[13px] text-foreground outline-none"
      >
        <Popover
          open={picker === 'date'}
          onOpenChange={(open) => setPicker(open ? 'date' : null)}
        >
          <PopoverTrigger asChild>
            <button
              type="button"
              data-testid="table-date-trigger"
              onClick={() => setPicker('date')}
              className={cn(
                'flex h-full min-w-0 flex-1 items-center gap-1.5 px-2 text-left outline-none transition-colors hover:bg-accent/50',
                picker === 'date' && 'bg-accent/45',
              )}
            >
              <CalendarDays className="size-3.5 shrink-0 text-muted-foreground" />
              <span className={cn('truncate tabular-nums', !datePart && 'text-muted-foreground')}>
                {datePart || 'YYYY-MM-DD'}
              </span>
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            side="bottom"
            sideOffset={4}
            collisionPadding={8}
            data-testid="table-date-calendar"
            className="click-outside-ignore w-[282px] rounded-lg border border-border bg-popover p-0 shadow-floating"
            onOpenAutoFocus={(event) => event.preventDefault()}
          >
            <div className="flex items-center justify-between px-3 pb-2 pt-3">
              <span className="text-sm font-semibold text-foreground">{monthLabel}</span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => moveMonth(-1)}
                  aria-label="Previous month"
                  className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <ChevronLeft className="size-4" />
                </button>
                <button
                  type="button"
                  onClick={() => moveMonth(1)}
                  aria-label="Next month"
                  className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <ChevronRight className="size-4" />
                </button>
              </div>
            </div>
            <div className="grid grid-cols-7 px-3 pb-1 text-center text-[11px] font-medium text-muted-foreground">
              {weekdays.map((weekday, index) => <span key={`${weekday}-${index}`}>{weekday}</span>)}
            </div>
            <div className="grid grid-cols-7 gap-y-1 px-3 pb-3">
              {cells.map((date) => {
                const inMonth = date.getMonth() === viewDate.getMonth()
                const selected = selectedDate ? isSameDay(date, selectedDate) : false
                const currentDay = isSameDay(date, today)
                return (
                  <button
                    key={`${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`}
                    type="button"
                    onClick={() => chooseDate(date)}
                    className={cn(
                      'mx-auto grid size-8 place-items-center rounded-full text-xs tabular-nums transition-colors',
                      inMonth ? 'text-foreground' : 'text-muted-foreground/45',
                      !selected && 'hover:bg-accent',
                      currentDay && !selected && 'ring-1 ring-inset ring-primary/70 text-primary',
                      selected && 'bg-primary font-semibold text-primary-foreground shadow-sm hover:bg-primary/90',
                    )}
                  >
                    {date.getDate()}
                  </button>
                )
              })}
            </div>
            <div className="flex items-center justify-between border-t border-border px-3 py-2">
              <button
                type="button"
                onClick={() => commit('')}
                className="rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                {t('datePicker.clear', { defaultValue: 'Clear' })}
              </button>
              <button
                type="button"
                onClick={() => commit(editorValueFromDate(inputType, new Date()))}
                className="rounded-md px-2 py-1 text-xs font-semibold text-primary hover:bg-primary/10"
              >
                {t('datePicker.today', { defaultValue: 'Today' })}
              </button>
            </div>
          </PopoverContent>
        </Popover>

        {inputType === 'datetime-local' ? (
          <Popover
            open={picker === 'time'}
            onOpenChange={(open) => setPicker(open ? 'time' : null)}
          >
            <PopoverTrigger asChild>
              <button
                type="button"
                data-testid="table-date-time-trigger"
                onClick={() => setPicker('time')}
                className={cn(
                  'flex h-full w-[78px] shrink-0 items-center gap-1 border-l border-border px-2 outline-none transition-colors hover:bg-accent/50',
                  picker === 'time' && 'bg-accent/45',
                )}
              >
                <Clock3 className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="tabular-nums">{timePart || '00:00'}</span>
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              side="bottom"
              sideOffset={4}
              collisionPadding={8}
              data-testid="table-date-time-menu"
              className="click-outside-ignore max-h-[240px] w-[92px] overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-floating"
              onOpenAutoFocus={(event) => event.preventDefault()}
            >
              {timeOptions.map((time) => {
                const selected = time === timePart
                return (
                  <button
                    key={time}
                    ref={selected ? selectedTimeRef : undefined}
                    type="button"
                    onClick={() => chooseTime(time)}
                    className={cn(
                      'flex h-8 w-full items-center justify-center rounded-md text-xs tabular-nums transition-colors',
                      selected
                        ? 'bg-primary font-semibold text-primary-foreground'
                        : 'text-foreground hover:bg-accent',
                    )}
                  >
                    {time}
                  </button>
                )
              })}
            </PopoverContent>
          </Popover>
        ) : null}
      </div>
    )
  },
)
