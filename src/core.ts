import type * as nt from 'nekoton-wasm';

const core = {
  ensureNekotonLoaded: undefined as unknown,
  nekoton: undefined as unknown, // will be initialized during start
  fetch: undefined as unknown,
  debugLog: undefined as unknown,
} as {
  ensureNekotonLoaded: () => Promise<void>,
  nekoton: typeof nt,
  fetch: typeof fetch,
  debugLog: (...data: any[]) => void,
};

export default core;
