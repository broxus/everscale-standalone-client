const nekoton = require('nekoton-wasm/node');
const fetch = require('node-fetch');
const http = require('http');
const https = require('https');

const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

import core from './core';

core.ensureNekotonLoaded = (): Promise<void> => Promise.resolve();
core.nekoton = nekoton;
core.fetch = fetch as any;
core.fetchAgent = url => (new URL(url).protocol == 'http:' ? httpAgent : httpsAgent);
core.debugLog = _nothing => {
  /* do nothing */
};

export * from './client';
