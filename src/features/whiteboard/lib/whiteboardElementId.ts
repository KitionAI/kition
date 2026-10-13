import { newObjectId } from '@/lib/kdm/ids'

/**
 * A new id for a whiteboard object (element or page): a UUID v7 from the KDM, unique across
 * replicas without coordination.
 */
export function createWhiteboardObjectId() {
  return newObjectId()
}
