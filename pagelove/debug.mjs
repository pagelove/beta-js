/**
 * Pagelove debug channels — bitwise gating for module-level console logging.
 *
 * Usage from devtools:
 *   Pagelove.debug |= Pagelove.SSE;     // enable SSE channel
 *   Pagelove.debug = Pagelove.ALL;      // enable everything
 *   Pagelove.debug = 0;                 // silence
 *
 * Modules log via:
 *   import { Pagelove } from '/js/pagelove-debug.mjs';
 *   Pagelove.log(Pagelove.SSE, '[PLSSE] …', …);
 *   Pagelove.warn(Pagelove.SSE, '[PLSSE] …', …);
 *
 * The active mask is persisted to localStorage.pagelove_debug when available,
 * so it survives page reloads.
 */

const STORAGE_KEY = 'pagelove_debug';

const hasStorage = (() => {
  try {
    return typeof localStorage !== 'undefined';
  } catch (_) {
    return false;
  }
})();

const initialDebug = (() => {
  if (!hasStorage) return 0;
  const raw = localStorage.getItem(STORAGE_KEY);
  const n = Number(raw);
  return Number.isFinite(n) ? n | 0 : 0;
})();

export const Pagelove = {
  // Channel bit flags
  SSE:        1 << 0,
  PRIMITIVES: 1 << 1,
  SCHEMA:     1 << 2,
  ALL:        ~0,

  _debug: initialDebug,

  get debug() {
    return this._debug;
  },
  set debug(value) {
    this._debug = value | 0;
    if (hasStorage) {
      try { localStorage.setItem(STORAGE_KEY, String(this._debug)); } catch (_) {}
    }
  },

  log(channel, ...args) {
    if (this._debug & channel) console.log(...args);
  },
  warn(channel, ...args) {
    if (this._debug & channel) console.warn(...args);
  },
  error(channel, ...args) {
    if (this._debug & channel) console.error(...args);
  },
};

if (typeof window !== 'undefined') {
  window.Pagelove = Pagelove;
}
