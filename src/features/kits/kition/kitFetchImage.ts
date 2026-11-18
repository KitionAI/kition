/**
 * `host/fetchImage` (Kit UI protocol section 7l): a picture the person pasted into a kit by its web
 * address. The page cannot read another site's picture, so the runtime downloads it, from public
 * addresses only; a refusal reaches the kit with the runtime's reason.
 */
import { fetchKitImage } from '@/api/kits'
import { FETCH_IMAGE_ERROR_REASONS, KitRpcError, type KitFetchImageResult, type KitFetchImageType } from '../host/protocol'

export async function kitionFetchImage({ url }: { url: string }): Promise<KitFetchImageResult> {
  try {
    const { bytes, mime } = await fetchKitImage(url)
    // mountKit refuses a type outside FETCH_IMAGE_TYPES (`unsupported`).
    return { bytes, mime: mime as KitFetchImageType }
  } catch (error) {
    const reason = (error as { response?: { data?: { data?: { reason?: unknown } } } }).response?.data?.data?.reason
    const known = (FETCH_IMAGE_ERROR_REASONS as readonly unknown[]).includes(reason) ? reason : 'io-error'
    throw new KitRpcError(-32000, error instanceof Error ? error.message : String(error), { reason: known })
  }
}
