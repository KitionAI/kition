import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/api/queryKeys'
import { readWorkspaceDocument, writeWorkspaceDocument } from '@/services/desktop'
import { BRAND_KIT_PATH, parseBrandKit, serializeBrandKit, type BrandKitFile } from '../lib/designBrand'

/** Reads the workspace brand kit; null when the workspace has none yet. */
async function loadWorkspaceBrandKit(root: string): Promise<BrandKitFile | null> {
  try {
    const file = await readWorkspaceDocument(BRAND_KIT_PATH, root)
    return parseBrandKit(file.content)
  } catch {
    return null
  }
}

export function useWorkspaceBrandKit(root: string) {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: queryKeys.brandKit(root),
    queryFn: () => loadWorkspaceBrandKit(root),
    enabled: Boolean(root),
    staleTime: 60_000,
  })
  const save = useMutation({
    mutationFn: async (kit: BrandKitFile) => {
      await writeWorkspaceDocument(BRAND_KIT_PATH, serializeBrandKit(kit))
      return kit
    },
    onSuccess: (kit) => {
      queryClient.setQueryData(queryKeys.brandKit(root), kit)
    },
  })
  return { kit: query.data ?? null, loading: query.isPending, save }
}
