'use client';

import { useSyncExternalStore } from 'react';

/**
 * A custom hook that returns a boolean value indicating whether the component
 * is mounted (client-side) or not. Useful for preventing hydration mismatches
 * when rendering different content on server vs client.
 */
export const useMounted = () => {
  return useSyncExternalStore(
    subscribe, // subscribe: no-op, never changes
    () => true, // getSnapshot (client): always true
    () => false // getServerSnapshot (SSR): always false
  );
};

const subscribe = () => () => {};
