/**
 * The design document library as one module, so callers outside the
 * feature can load it on first use. The serializer validates with zod,
 * which is why this stays out of the startup bundle.
 */
export { existingDesignImage, insertDesignImage } from './designAssets'
export { createDesignFile } from './designFile'
export { placeImageInDesign } from './designImageTargets'
export { parseDesign } from './designSerialization'
export { createDesign } from './designTypes'
