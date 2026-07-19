/**
 * browser-polyfill.js
 *
 * Minimal cross-browser compatibility shim.
 *
 * Firefox exposes the WebExtension API under the `browser` global and
 * returns native Promises. Chrome (MV3) exposes it under `chrome` and,
 * for the vast majority of methods we use here (storage, tabs, windows,
 * alarms, idle, contextMenus), also supports Promise-based calls when no
 * callback is supplied. This module simply normalizes on a single
 * `api` object so the rest of the extension never has to branch on
 * runtime.
 *
 * We intentionally avoid pulling in the full official webextension-polyfill
 * bundle to keep the extension dependency-free, offline-buildable, and
 * easy to audit line-by-line (important for a security-focused tool).
 */

const api = typeof globalThis.browser !== "undefined" ? globalThis.browser : globalThis.chrome;

/** True when running under a genuine `browser.*` (promise-native) runtime. */
export const isFirefoxLike = typeof globalThis.browser !== "undefined";

/** True when running as a background service worker (vs. a page context). */
export const isServiceWorker =
  typeof globalThis.ServiceWorkerGlobalScope !== "undefined" &&
  globalThis instanceof globalThis.ServiceWorkerGlobalScope;

export default api;
