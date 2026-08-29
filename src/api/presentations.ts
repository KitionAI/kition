import request from './request'
import type {
  PresentationInspectRequest,
  PresentationInspectResponse,
  PresentationRenderRequest,
  PresentationRenderResponse,
} from '@/features/presentation/lib/presentationTypes'

function unwrapResponseData<T>(response: T | { data?: T }) {
  return (response as { data?: T })?.data ?? (response as T)
}

export function inspectPresentation(input: PresentationInspectRequest) {
  return request
    .post<PresentationInspectResponse | { data?: PresentationInspectResponse }>(
      '/v1/presentations/inspect',
      input,
    )
    .then(unwrapResponseData<PresentationInspectResponse>)
}

export function renderPresentation(input: PresentationRenderRequest) {
  return request
    .post<PresentationRenderResponse | { data?: PresentationRenderResponse }>(
      '/v1/presentations/render',
      input,
    )
    .then(unwrapResponseData<PresentationRenderResponse>)
}
