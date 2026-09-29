import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/api/queryKeys'
import { writeWorkspaceDocument } from '@/services/desktop'
import { BRAND_KIT_PATH, serializeBrandKit, type BrandKitFile } from '../lib/designBrandFile'

export function useWorkspaceBrandKit(root: string) {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: queryKeys.brandKit(root),
    queryFn: async () => {
      const { loadWorkspaceBrandKit } = await import('../lib/designBrand')
      return loadWorkspaceBrandKit(root)
    },
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
