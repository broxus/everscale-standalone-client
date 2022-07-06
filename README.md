<p align="center">
    <h3 align="center">Everscale standalone client</h3>
    <p align="center">Standalone client to the Everscale blockchain to use with <a href="https://github.com/broxus/everscale-inpage-provider"><code>everscale-inpage-provider</code></a></p>
    <p align="center">
        <a href="/LICENSE">
            <img alt="GitHub" src="https://img.shields.io/github/license/broxus/everscale-standalone-client" />
        </a>
        <a href="https://www.npmjs.com/package/everscale-standalone-client">
            <img alt="npm" src="https://img.shields.io/npm/v/everscale-standalone-client">
        </a>
    </p>
    <p align="center"><b><a href="https://broxus.github.io/everscale-standalone-client/index.html">Documentation</a></b></p>
</p>

### How to install

```shell
npm install --save everscale-inpage-provider everscale-standalone-client
```

### Example

```typescript
import { Address, ProviderRpcClient, TvmException } from 'everscale-inpage-provider';

// For browser environment:
import { EverscaleStandaloneClient } from 'everscale-standalone-client';
// Or for nodejs environment:
// import { EverscaleStandaloneClient } from 'everscale-standalone-client/nodejs';

const ever = new ProviderRpcClient({
  fallback: () =>
    EverscaleStandaloneClient.create({
      connection: 'mainnet',
    }),
});

async function myApp() {
  await ever.ensureInitialized();

  await ever.requestPermissions({
    permissions: ['basic'],
  });

  const dePoolAddress = new Address('0:bbcbf7eb4b6f1203ba2d4ff5375de30a5408a8130bf79f870efbcfd49ec164e9');

  const dePool = new ever.Contract(DePoolAbi, dePoolAddress);

  try {
    const output = await dePool.methods.getDePoolInfo({}).call();
    console.log(output);
  } catch (e) {
    if (e instanceof TvmException) {
      console.error(e.code);
    }
  }
}

const DePoolAbi = {
  'ABI version': 2,
  header: ['time', 'expire'],
  functions: [
    {
      name: 'getDePoolInfo',
      inputs: [],
      outputs: [
        { name: 'poolClosed', type: 'bool' },
        { name: 'minStake', type: 'uint64' },
        { name: 'validatorAssurance', type: 'uint64' },
        { name: 'participantRewardFraction', type: 'uint8' },
        { name: 'validatorRewardFraction', type: 'uint8' },
        { name: 'balanceThreshold', type: 'uint64' },
        { name: 'validatorWallet', type: 'address' },
        { name: 'proxies', type: 'address[]' },
        { name: 'stakeFee', type: 'uint64' },
        { name: 'retOrReinvFee', type: 'uint64' },
        { name: 'proxyFee', type: 'uint64' },
      ],
    },
  ],
  data: [],
  events: [],
} as const; // NOTE: `as const` is very important here

myApp().catch(console.error);
```
### Build with Vite
Using [Vite](https://vitejs.dev) you will stuck with [issue](https://github.com/vitejs/vite/issues/8427). As workaround you may initialize provider like in the example below.

```js
import { Address, ProviderRpcClient } from 'everscale-inpage-provider';
import { EverscaleStandaloneClient } from 'everscale-standalone-client';

const client = new ProviderRpcClient({
  forceUseFallback: true,
  fallback: () =>
    EverscaleStandaloneClient.create({
      connection: 'mainnet',
      initInput: '../../node_modules/nekoton-wasm/nekoton_wasm_bg.wasm',
    }),
});

```
