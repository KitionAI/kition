import { useState, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { installWorkspaceInvalidation } from '@/api/invalidation'

/**
 * Defaults for a local desktop runtime: the data lives on this machine, so
 * refetch-on-focus is noise, retries only hide runtime restarts, and a short
 * staleTime lets several panes share one request without going stale for
 * long. Invalidation comes from workspace change events, not timers.
 */
function createAppQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        gcTime: 5 * 60_000,
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
      mutations: {
        retry: false,
      },
    },
  })
}

export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(() => {
    const queryClient = createAppQueryClient()
    installWorkspaceInvalidation(queryClient)
    return queryClient
  })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}
