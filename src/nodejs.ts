/* @ts-ignore */
const nekoton = require('nekoton-wasm');
/* @ts-ignore */
const fetch = require('node-fetch');
/* @ts-ignore */
const http = require('http');
/* @ts-ignore */
const https = require('https');

const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

import core from './core';

core.ensureNekotonLoaded = (): Promise<void> => Promise.resolve();
core.nekoton = nekoton;
core.fetch = fetch as any;
core.fetchAgent = (url) => new URL(url).protocol == 'http:' ? httpAgent : httpsAgent;
core.debugLog = (_nothing) => { /* do nothing */
};

export * from './client';
