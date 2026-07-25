import type { DataDateFormat, DataField, DataFieldType } from '@/types/dataDocument'

import { displayValue } from './tableEditorShared'

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

export const TABLE_DATE_FORMATS: DataDateFormat[] = [
  'year_month_day_slash',
  'year_month_day_time_slash',
  'year_month_day_time_zone_slash',
  'year_month_day_dash',
  'year_month_day_time_dash',
  'year_month_day_time_zone_dash',
  'month_day_dash',
  'month_day_year_slash',
  'day_month_year_slash',
]

const DATE_FORMAT_SET = new Set<DataDateFormat>(TABLE_DATE_FORMATS)

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function parseCalendarDate(value: string): Date | null {
  const match = DATE_ONLY_PATTERN.exec(value)
  if (!match) return null

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day)

  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
  ) {
    return null
  }

  return date
}

function defaultDateFormat(type: DataFieldType): DataDateFormat {
  return type === 'date' ? 'year_month_day_slash' : 'year_month_day_time_slash'
}

export function getTableDateFormat(field: Pick<DataField, 'type' | 'options'>): DataDateFormat {
  const configured = field.options?.date_format
  return typeof configured === 'string' && DATE_FORMAT_SET.has(configured as DataDateFormat)
    ? configured as DataDateFormat
    : defaultDateFormat(field.type)
}

function parseFieldDate(field: Pick<DataField, 'type'>, value: string): Date | null {
  if (field.type === 'date' && DATE_ONLY_PATTERN.test(value)) {
    return parseCalendarDate(value)
  }

  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function timezoneLabel(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absoluteMinutes = Math.abs(offsetMinutes)
  const hours = Math.floor(absoluteMinutes / 60)
  const minutes = absoluteMinutes % 60
  return `GMT${sign}${hours}${minutes ? `:${pad(minutes)}` : ''}`
}

function formatWithPattern(date: Date, format: DataDateFormat): string {
  const year = String(date.getFullYear())
  const month = pad(date.getMonth() + 1)
  const day = pad(date.getDate())
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`

  switch (format) {
    case 'year_month_day_time_slash':
      return `${year}/${month}/${day} ${time}`
    case 'year_month_day_time_zone_slash':
      return `${year}/${month}/${day} ${time} (${timezoneLabel(date)})`
    case 'year_month_day_dash':
      return `${year}-${month}-${day}`
    case 'year_month_day_time_dash':
      return `${year}-${month}-${day} ${time}`
    case 'year_month_day_time_zone_dash':
      return `${year}-${month}-${day} ${time} (${timezoneLabel(date)})`
    case 'month_day_dash':
      return `${month}-${day}`
    case 'month_day_year_slash':
      return `${month}/${day}/${year}`
    case 'day_month_year_slash':
      return `${day}/${month}/${year}`
    case 'year_month_day_slash':
    default:
      return `${year}/${month}/${day}`
  }
}

export function formatTableFieldValue(
  field: Pick<DataField, 'type' | 'options'>,
  value: unknown,
): string {
  const text = displayValue(value)
  if (!text) return ''

  const isDateField = field.type === 'date'
    || field.type === 'datetime'
    || field.type === 'created_time'
    || field.type === 'last_modified_time'
  if (!isDateField) return text

  const date = parseFieldDate(field, text)
  if (!date) return text

  return formatWithPattern(date, getTableDateFormat(field))
}

export function toDateInputValue(
  inputType: 'date' | 'datetime-local',
  value: unknown,
): string {
  const text = displayValue(value)
  if (!text) return ''

  if (inputType === 'date' && DATE_ONLY_PATTERN.test(text)) {
    return parseCalendarDate(text) ? text : ''
  }

  const date = new Date(text)
  if (Number.isNaN(date.getTime())) return ''

  const datePart = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  if (inputType === 'date') return datePart

  return `${datePart}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function fromDateInputValue(
  inputType: 'date' | 'datetime-local',
  value: string,
): string {
  if (!value || inputType === 'date') return value

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value

  return date.toISOString()
}
