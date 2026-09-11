'use client';

import * as React from 'react';

function subscribe(onChange: () => void): () => void {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

/**
 * The browser's own connectivity flag.
 *
 * `navigator.onLine` is a hint, not a guarantee — it only knows the OS has *a*
 * network, not that the server is reachable — but it is the one signal a page
 * gets for free, and it is enough to (a) reassure a candidate whose wifi
 * dropped that their work is held locally, and (b) retry the cloud save the
 * instant it comes back. `useSyncExternalStore` with a `true` server snapshot
 * keeps the server render and the first client render in agreement.
 */
export function useOnlineStatus(): boolean {
  return React.useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );
}
