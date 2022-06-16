import init, * as nt from 'nekoton-wasm';
import core from './core';

let clientInitializationStarted: boolean = false;
let notifyClientInitialized: { resolve: () => void, reject: () => void };
let initializationPromise: Promise<void> = new Promise<void>((resolve, reject) => {
  notifyClientInitialized = { resolve, reject };
});

core.ensureNekotonLoaded = (initInput?: nt.InitInput | Promise<nt.InitInput>): Promise<void> => {
  if (!clientInitializationStarted) {
    clientInitializationStarted = true;
    init(initInput).then(notifyClientInitialized.resolve).catch(notifyClientInitialized.reject);
  }
  return initializationPromise;
};
core.nekoton = nt;
core.fetch = fetch;
core.debugLog = console.debug;

export * from './client';
