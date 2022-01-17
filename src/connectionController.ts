import { Mutex } from '@broxus/await-semaphore';
import * as nt from 'nekoton-wasm';

import { GqlSocket, GqlSocketParams } from './gql';

export const DEFAULT_NETWORK_GROUP = 'mainnet';

/**
 * @category Client
 */
export const NETWORK_PRESETS = {
  mainnet: {
    group: 'mainnet',
    type: 'graphql',
    data: {
      endpoints: ['main2.ton.dev', 'main3.ton.dev', 'main4.ton.dev'],
      latencyDetectionInterval: 60000,
      local: false,
    },
  } as ConnectionData,
  testnet: {
    group: 'testnet',
    type: 'graphql',
    data: {
      endpoints: ['eri01.net.everos.dev', 'rbx01.net.everos.dev', 'gra01.net.everos.dev'],
      latencyDetectionInterval: 60000,
      local: false,
    },
  } as ConnectionData,
  fld: {
    group: 'fld',
    type: 'graphql',
    data: {
      endpoints: ['gql.custler.net'],
      latencyDetectionInterval: 60000,
      local: false,
    },
  } as ConnectionData,
  local: {
    group: 'localnet',
    type: 'graphql',
    data: {
      endpoints: ['127.0.0.1'],
      latencyDetectionInterval: 60000,
      local: true,
    },
  } as ConnectionData,
} as const;

/**
 * @category Client
 */
export type ConnectionProperties = (keyof typeof NETWORK_PRESETS) | ConnectionData

export async function createConnectionController(
  clock: nt.ClockWithOffset,
  params: ConnectionProperties,
  retry: boolean = false,
): Promise<ConnectionController> {
  let preset: ConnectionData;

  if (typeof params === 'string') {
    const targetPreset = NETWORK_PRESETS[params] as ConnectionData | undefined;
    if (targetPreset == null) {
      throw new Error(`Target preset id not found: ${params}`);
    }
    preset = targetPreset;
  } else {
    preset = params;
  }

  // Try connect
  while (true) {
    try {
      const controller = new ConnectionController(clock);
      await controller.startSwitchingNetwork(preset).then((handle) => handle.switch());
      console.debug(`Successfully connected to ${preset.group}`);
      return controller;
    } catch (e: any) {
      if (retry) {
        console.error('Connection failed:', e);
        await new Promise<void>((resolve) => {
          setTimeout(() => resolve(), 5000);
        });
        console.log('Restarting connection process');
      } else {
        throw e;
      }
    }
  }
}

export class ConnectionController {
  private readonly _clock: nt.ClockWithOffset;
  private _initializedTransport?: InitializedTransport;
  private _networkMutex: Mutex = new Mutex();
  private _release?: () => void;
  private _acquiredTransportCounter: number = 0;
  private _cancelTestTransport?: () => void;

  constructor(clock: nt.ClockWithOffset) {
    this._clock = clock;
  }

  public async acquire() {
    requireInitializedTransport(this._initializedTransport);
    await this._acquireTransport();

    return {
      transport: this._initializedTransport,
      release: () => this._releaseTransport(),
    };
  }

  public async use<T>(f: (transport: InitializedTransport) => Promise<T>): Promise<T> {
    requireInitializedTransport(this._initializedTransport);
    await this._acquireTransport();

    return f(this._initializedTransport)
      .finally(() => {
        this._releaseTransport();
      });
  }

  public async startSwitchingNetwork(params: ConnectionData): Promise<INetworkSwitchHandle> {
    class NetworkSwitchHandle implements INetworkSwitchHandle {
      private readonly _controller: ConnectionController;
      private readonly _release: () => void;
      private readonly _params: ConnectionData;

      constructor(
        controller: ConnectionController,
        release: () => void,
        params: ConnectionData,
      ) {
        this._controller = controller;
        this._release = release;
        this._params = params;
      }

      public async switch() {
        await this._controller
          ._connect(this._params)
          .finally(() => this._release());
      }
    }

    this._cancelTestTransport?.();

    const release = await this._networkMutex.acquire();
    return new NetworkSwitchHandle(this, release, params);
  }

  public get currentConnectionGroup(): string | undefined {
    return this._initializedTransport?.group;
  }

  private async _connect(params: ConnectionData) {
    if (this._initializedTransport) {
      this._initializedTransport.data.transport.free();
    }
    this._initializedTransport = undefined;

    enum TestConnectionResult {
      DONE,
      CANCELLED,
    }

    const testTransport = async ({ data: { transport } }: InitializedTransport): Promise<TestConnectionResult> => {
      return new Promise<TestConnectionResult>((resolve, reject) => {
        this._cancelTestTransport = () => resolve(TestConnectionResult.CANCELLED);

        // Try to get any account state
        transport
          .getFullContractState(
            '-1:0000000000000000000000000000000000000000000000000000000000000000',
          )
          .then(() => resolve(TestConnectionResult.DONE))
          .catch((e) => reject(e));

        setTimeout(() => reject(new Error('Connection timeout')), 10000);
      }).finally(() => this._cancelTestTransport = undefined);
    };

    try {
      // TODO: add jrpc transport
      const { shouldTest, transportData } = await (async () => {
        const socket = new GqlSocket();
        const transport = await socket.connect(this._clock, params.data);

        return {
          shouldTest: !params.data.local,
          transport,
          transportData: {
            type: 'graphql',
            data: {
              socket,
              transport,
            },
          } as InitializedTransport,
        };
      })();

      if (shouldTest && (await testTransport(transportData)) == TestConnectionResult.CANCELLED) {
        transportData.data.transport.free();
        return;
      }

      this._initializedTransport = transportData;
    } catch (e: any) {
      throw new Error(`Failed to create connection: ${e.toString()}`);
    }
  }

  private async _acquireTransport() {
    console.debug('_acquireTransport');

    if (this._acquiredTransportCounter > 0) {
      console.debug('_acquireTransport -> increase');
      this._acquiredTransportCounter += 1;
    } else {
      this._acquiredTransportCounter = 1;
      if (this._release != null) {
        console.warn('mutex is already acquired');
      } else {
        console.debug('_acquireTransport -> await');
        this._release = await this._networkMutex.acquire();
        console.debug('_acquireTransport -> create');
      }
    }
  }

  private _releaseTransport() {
    console.debug('_releaseTransport');

    this._acquiredTransportCounter -= 1;
    if (this._acquiredTransportCounter <= 0) {
      console.debug('_releaseTransport -> release');
      this._release?.();
      this._release = undefined;
    }
  }
}

interface INetworkSwitchHandle {
  // Must be called after all connection usages are gone
  switch(): Promise<void>;
}

function requireInitializedTransport(transport?: InitializedTransport): asserts transport is InitializedTransport {
  if (transport == null) {
    throw new Error('Connection is not initialized');
  }
}

/**
 * @category Client
 */
export type ConnectionData = { group: string } & (
  | nt.EnumItem<'graphql', GqlSocketParams>
  )

/**
 * @category Client
 */
export type InitializedTransport = { group: string } & (
  | nt.EnumItem<'graphql', { socket: GqlSocket, transport: nt.GqlTransport }>
  )
