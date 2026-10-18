// Copied from kition-sdk packages/sdk/src/kits.ts by scripts/sync-kit-host.mjs; change it there, not here.
/** A kit the object model knows: its id and its KDM schema (`model/schema.json`). */
export type KitDescriptor = { id: string; schema: object }

const KITS = new Map<string, KitDescriptor>()

/** Makes a kit's schema known to `openDocument` (generated descriptors in `@kition/sdk/kits/*`). */
export function registerKit(kit: KitDescriptor): KitDescriptor {
  KITS.set(kit.id, kit)
  return kit
}

export const kitDescriptor = (id: string): KitDescriptor | undefined => KITS.get(id)
