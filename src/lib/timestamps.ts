import type { ApiTimestamp } from '@/types'

/** Unix milliseconds for a runtime timestamp (milliseconds or an ISO
 *  string); `NaN` when it is missing or unparseable. */
export function toEpochMs(value: ApiTimestamp | null | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number.NaN
  if (typeof value !== 'string' || !value.trim()) return Number.NaN
  const trimmed = value.trim()
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed)
  return Date.parse(trimmed)
}

/** An ISO string for a runtime timestamp, or `''` when it is unparseable. */
export function toIsoTimestamp(value: ApiTimestamp | null | undefined): string {
  const ms = toEpochMs(value)
  return Number.isNaN(ms) ? '' : new Date(ms).toISOString()
}
