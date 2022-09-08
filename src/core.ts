import type * as nt from 'nekoton-wasm';

const core = {
  ensureNekotonLoaded: undefined as unknown,
  nekoton: undefined as unknown, // will be initialized during start
  fetch: undefined as unknown,
  fetchAgent: () => undefined,
  debugLog: undefined as unknown,
} as {
  ensureNekotonLoaded: (initInput?: nt.InitInput | Promise<nt.InitInput>) => Promise<void>,
  nekoton: typeof nt,
  fetch: typeof fetch,
  fetchAgent: (url: string) => any,
  debugLog: (...data: any[]) => void,
};

export default core;
