import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Joins class names, later Tailwind utilities winning over earlier ones (`cn('px-2', active && 'px-4')`). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
