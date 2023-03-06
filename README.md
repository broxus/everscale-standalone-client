<p align="center">
  <a href="https://github.com/venom-blockchain/developer-program">
    <img src="https://raw.githubusercontent.com/venom-blockchain/developer-program/main/vf-dev-program.png" alt="Logo" width="366.8" height="146.4">
  </a>
</p>

# Everscale standalone client &emsp;  [![Latest Version]][npmjs.com] [![Docs badge]][docs]

## About

Standalone client to the Everscale blockchain to use with [`everscale-inpage-provider`](https://github.com/broxus/everscale-inpage-provider).

## Usage

### Install

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
      connection: {
        id: 2, // network id
        type: 'graphql',
        data: {
          // create your own project at https://dashboard.evercloud.dev
          endpoints: ['https://devnet-sandbox.evercloud.dev/graphql'],
        },
      },
    }),
});

async function myApp() {
  await ever.ensureInitialized();

  await ever.requestPermissions({
    permissions: ['basic'],
  });

  const dePoolAddress = new Address('0:2e0ea1716eb93db16077d30e51d092b075ce7f0eb1c08ca5bea67ef48a79368e');

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
      connection: {
        /*...*/
      },
      initInput: '../../node_modules/nekoton-wasm/nekoton_wasm_bg.wasm',
    }),
});
```

## Contributing

We welcome contributions to the project! If you notice any issues or errors, feel free to open an issue or submit a pull request.

## License

Licensed under GPL-3.0 license ([LICENSE](/LICENSE) or https://opensource.org/license/gpl-3-0/).

[latest version]: https://img.shields.io/npm/v/everscale-standalone-client
[npmjs.com]: https://www.npmjs.com/package/everscale-standalone-client
[docs badge]: https://img.shields.io/badge/docs-latest-brightgreen
[docs]: https://broxus.github.io/everscale-standalone-client/index.html
