import { lazy, Suspense, type ComponentProps } from 'react'

const ImageStudio = lazy(() => import('./ImageStudio').then((module) => ({ default: module.ImageStudio })))

export function LazyImageStudio(props: ComponentProps<typeof ImageStudio>) {
  return (
    <Suspense fallback={null}>
      <ImageStudio {...props} />
    </Suspense>
  )
}
