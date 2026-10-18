import { useMediaQuery } from '@kition/app-ui/hooks/use-media-query'

export const useIsTouchDevice = (): boolean => useMediaQuery('(pointer: coarse)')
