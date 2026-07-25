import type { PaginationResponse } from '@/types'

type ApiEnvelope<T> = {
  code?: number
  message?: string
  data?: T
}

export const unwrapResponseData = <T>(response: ApiEnvelope<T> | T | null | undefined, fallback: T): T => {
  if (response && typeof response === 'object' && 'data' in response) {
    return ((response as ApiEnvelope<T>).data ?? fallback) as T
  }

  return ((response as T) ?? fallback) as T
}

export const unwrapArrayResponse = <T>(response: ApiEnvelope<T[]> | T[] | null | undefined): T[] => {
  return unwrapResponseData<T[]>(response, [])
}

export const unwrapPaginationResponse = <T>(
  response: ApiEnvelope<Partial<PaginationResponse<T>>> | Partial<PaginationResponse<T>> | null | undefined,
): PaginationResponse<T> => {
  const payload = unwrapResponseData<Partial<PaginationResponse<T>>>(response, {})

  return {
    items: payload.items || [],
    total: payload.total || 0,
    page: payload.page || 1,
    page_size: payload.page_size || 0,
    pages: payload.pages || 0,
  }
}
