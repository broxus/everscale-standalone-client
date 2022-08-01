/* @ts-ignore */
const nekoton = require('nekoton-wasm');
/* @ts-ignore */
const fetch = require('node-fetch');
import core from './core';

core.ensureNekotonLoaded = (): Promise<void> => Promise.resolve();
core.nekoton = nekoton;
core.fetch = fetch as any;
core.debugLog = (_nothing) => { /* do nothing */
};

export * from './client';
