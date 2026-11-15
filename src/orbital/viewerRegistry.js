/**
 * The page's Cesium viewer, published once by the scene and read by Orbital Watch.
 * Views mount before the viewer exists on some boots, so a listener is supported.
 */
let current = null;
const listeners = new Set();

/** Publish the viewer (or null on teardown). */
export function publishViewer(viewer) {
  current = viewer ?? null;
  for (const fn of listeners) fn(current);
}

/** The live viewer, or null before it exists or after it is destroyed. */
export function currentViewer() {
  return current && !current.isDestroyed?.() ? current : null;
}

/** Call `fn` with the viewer now and on each publish. Returns an unsubscribe. */
export function onViewer(fn) {
  listeners.add(fn);
  fn(currentViewer());
  return () => listeners.delete(fn);
}
