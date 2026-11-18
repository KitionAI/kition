/**
 * Test helpers for hooks and components that read through TanStack Query.
 * `createTestQueryClient` disables retries and caching so each test sees
 * exactly the responses it mocks; `withQueryClient` wraps a React element
 * in a provider for the createRoot-based hook harnesses used in this repo.
 */
import { createElement, type ReactElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

export function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  })
}

export function withQueryClient(element: ReactElement, client: QueryClient = createTestQueryClient()) {
  return createElement(QueryClientProvider, { client }, element)
}
