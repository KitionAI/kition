   
                
  
                                             
                                             
   

import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/registry/ui/dialog'
import { cn } from '@/lib/utils'
import { getCurrentLocale } from '@/i18n'

import { dateString, ensureDailyNoteFor } from '../daily-note'

export type DocumentDailyCalendarProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpen: (path: string) => void
}

function startOfMonth(year: number, month: number): Date {
  return new Date(year, month, 1)
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate()
}

                             
function mondayBasedWeekday(date: Date): number {
  const d = date.getDay()        
  return (d + 6) % 7
}

export function DocumentDailyCalendar({ open, onOpenChange, onOpen }: DocumentDailyCalendarProps) {
  const { t } = useTranslation('document')
  const today = useMemo(() => new Date(), [])
  const [year, setYear] = useState(today.getFullYear())
  const [month, setMonth] = useState(today.getMonth())

  const weekdays = useMemo(
    () => t('command.dailyCalendar.weekdays', { returnObjects: true }) as string[],
    [t],
  )

  const monthName = useMemo(() => {
    try {
      return new Intl.DateTimeFormat(getCurrentLocale(), { month: 'long' }).format(
        new Date(year, month, 1),
      )
    } catch {
      return String(month + 1)
    }
  }, [year, month])

  useEffect(() => {
    if (open) {
      setYear(today.getFullYear())
      setMonth(today.getMonth())
    }
  }, [open, today])

  const grid = useMemo(() => {
    const first = startOfMonth(year, month)
    const offset = mondayBasedWeekday(first)
    const days = daysInMonth(year, month)
    const cells: Array<{ key: string; date: Date | null; inMonth: boolean }> = []
    for (let i = 0; i < offset; i++) cells.push({ key: `pad-${i}`, date: null, inMonth: false })
    for (let i = 1; i <= days; i++) {
      const d = new Date(year, month, i)
      cells.push({ key: `d-${i}`, date: d, inMonth: true })
    }
    while (cells.length % 7 !== 0) {
      cells.push({ key: `trail-${cells.length}`, date: null, inMonth: false })
    }
    return cells
  }, [year, month])

  const handleNav = (delta: number) => {
    let m = month + delta
    let y = year
    while (m < 0) {
      m += 12
      y -= 1
    }
    while (m > 11) {
      m -= 12
      y += 1
    }
    setYear(y)
    setMonth(m)
  }

  const handlePick = (date: Date) => {
    void (async () => {
      const path = await ensureDailyNoteFor(date)
      onOpenChange(false)
      onOpen(path)
    })()
  }

  const isToday = (date: Date) =>
    date.getFullYear() === today.getFullYear()
    && date.getMonth() === today.getMonth()
    && date.getDate() === today.getDate()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('command.dailyCalendar.title')}</DialogTitle>
          <DialogDescription>{t('command.dailyCalendar.description')}</DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => handleNav(-1)}
            className="rounded p-1 hover:bg-accent/40"
            title={t('command.dailyCalendar.prevMonth')}
          >
            <ChevronLeft className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              setYear(today.getFullYear())
              setMonth(today.getMonth())
            }}
            className="rounded px-3 py-0.5 text-sm font-medium hover:bg-accent/40"
            title={t('command.dailyCalendar.jumpToCurrentMonth')}
          >
            {t('command.dailyCalendar.monthLabel', { year, monthName })}
          </button>
          <button
            type="button"
            onClick={() => handleNav(1)}
            className="rounded p-1 hover:bg-accent/40"
            title={t('command.dailyCalendar.nextMonth')}
          >
            <ChevronRight className="size-4" />
          </button>
        </div>
        <div className="grid grid-cols-7 gap-1 text-center text-[11px] text-muted-foreground">
          {weekdays.map((d) => (
            <div key={d}>{d}</div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-1">
          {grid.map((cell) => {
            if (!cell.date) return <div key={cell.key} className="h-8" />
            const today = isToday(cell.date)
            return (
              <button
                key={cell.key}
                type="button"
                onClick={() => handlePick(cell.date!)}
                className={cn(
                  'flex h-8 items-center justify-center rounded text-[12.5px] transition hover:bg-accent/60',
                  today && 'bg-primary/15 font-semibold text-primary',
                )}
                title={dateString(cell.date)}
              >
                {cell.date.getDate()}
              </button>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}
