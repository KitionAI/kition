import { useMediaQuery } from '@/registry/hooks/use-media-query'

export const useIsTouchDevice = (): boolean => useMediaQuery('(pointer: coarse)')
