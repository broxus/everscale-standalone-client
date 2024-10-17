import { Mutex } from '@broxus/await-semaphore';
import type * as nt from 'nekoton-wasm';

import core from '../../core';
import { GqlSocket, GqlSocketParams } from './gql';
import { JrpcSocket, JrpcSocketParams } from './jrpc';
import { ProxyParams } from './proxy';
import { ProtoSocket, ProtoSocketParams } from './proto';

export { GqlSocketParams } from './gql';
export { JrpcSocketParams } from './jrpc';

/**
 * @category Client
 */
export const NETWORK_PRESETS = {
  mainnetJrpc: {
    id: 1,
    type: 'jrpc',
    data: {
      endpoint: 'https://jrpc.everwallet.net/rpc',
    },
  } as ConnectionData,
  fld: {
    id: 10,
    type: 'graphql',
    data: {
      endpoints: ['gql.custler.net'],
      local: false,
    },
  } as ConnectionData,
  local: {
    id: 31337,
    type: 'graphql',
    data: {
      endpoints: ['127.0.0.1'],
      local: true,
    },
  } as ConnectionData,
} as const;

const matchNetworkGroup = (id: number): string => {
  switch (id) {
    case 1:
      return 'mainnet';
    case 2:
      return 'testnet';
    case 10:
      return 'fld';
    case 31337:
      return 'localnet';
    default:
      return `network${id}`;
  }
};

/**
 * @category Client
 */
export type ConnectionProperties = keyof typeof NETWORK_PRESETS | ConnectionData;

function loadPreset(params: ConnectionProperties): ConnectionData {
  if (typeof params === 'string') {
    const targetPreset = NETWORK_PRESETS[params] as ConnectionData | undefined;
    if (targetPreset == null) {
      throw new Error(`Target preset id not found: ${params}`);
    }
    return targetPreset;
  } else {
    return params;
  }
}

/**
 * Tries to connect with the specified params. Throws an exception in case of error
 *
 * @category Client
 * @throws ConnectionError
 */
export async function checkConnection(params: ConnectionProperties): Promise<void> {
  const preset = loadPreset(params);

  const clock = new core.nekoton.ClockWithOffset();
  try {
    const controller = new ConnectionController(clock);
    await controller['_connect'](preset);
    if (controller['_initializedTransport'] != null) {
      cleanupInitializedTransport(controller['_initializedTransport']);
    }
  } catch (e: any) {
    throw new ConnectionError(preset, e.toString());
  } finally {
    clock.free();
  }
}

/**
 * @category Client
 */
export class ConnectionError extends Error {
  constructor(
    public readonly params: ConnectionData,
    message: string,
  ) {
    super(message);
  }
}

export async function createConnectionController(
  clock: nt.ClockWithOffset,
  params: ConnectionProperties,
  retry = false,
): Promise<ConnectionController> {
  const preset = loadPreset(params);

  // Try connect
  while (true) {
    try {
      const controller = new ConnectionController(clock);
      await controller.startSwitchingNetwork(preset).then(handle => handle.switch());
      core.debugLog(`Successfully connected to ${preset.group}`);
      return controller;
    } catch (e: any) {
      if (retry) {
        console.error('Connection failed:', e);
        await new Promise<void>(resolve => {
          setTimeout(() => resolve(), 5000);
        });
        core.debugLog('Restarting connection process');
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
  private _acquiredTransportCounter = 0;
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

    return f(this._initializedTransport).finally(() => {
      this._releaseTransport();
    });
  }

  public async startSwitchingNetwork(params: ConnectionData): Promise<INetworkSwitchHandle> {
    class NetworkSwitchHandle implements INetworkSwitchHandle {
      private readonly _controller: ConnectionController;
      private readonly _release: () => void;
      private readonly _params: ConnectionData;

      constructor(controller: ConnectionController, release: () => void, params: ConnectionData) {
        this._controller = controller;
        this._release = release;
        this._params = params;
      }

      public async switch() {
        await this._controller._connect(this._params).finally(() => this._release());
      }
    }

    this._cancelTestTransport?.();

    const release = await this._networkMutex.acquire();
    return new NetworkSwitchHandle(this, release, params);
  }

  public get initializedTransport(): InitializedTransport | undefined {
    return this._initializedTransport;
  }

  private async _connect(params: ConnectionData) {
    if (this._initializedTransport != null) {
      cleanupInitializedTransport(this._initializedTransport);
    }
    this._initializedTransport = undefined;

    enum TestConnectionResult {
      DONE,
      CANCELLED,
    }

    const testTransport = async (
      { data: { transport } }: InitializedTransport,
      local: boolean,
    ): Promise<TestConnectionResult> => {
      return new Promise<TestConnectionResult>((resolve, reject) => {
        this._cancelTestTransport = () => resolve(TestConnectionResult.CANCELLED);

        if (local) {
          transport
            .getAccountsByCodeHash('4e92716de61d456e58f16e4e867e3e93a7548321eace86301b51c8b80ca6239b', 1)
            .then(() => resolve(TestConnectionResult.DONE))
            .catch((e: any) => reject(e));
        } else {
          // Try to get any account state
          transport
            .getFullContractState('-1:0000000000000000000000000000000000000000000000000000000000000000')
            .then(() => resolve(TestConnectionResult.DONE))
            .catch((e: any) => reject(e));
        }

        setTimeout(() => reject(new Error('Connection timeout')), 10000);
      }).finally(() => (this._cancelTestTransport = undefined));
    };

    try {
      const group = params.group != null ? params.group : matchNetworkGroup(params.id);

      const { local, transportData } = await (async () => {
        switch (params.type) {
          case 'graphql': {
            const socket = new GqlSocket();
            const connection = await socket.connect(params.data);
            const transport = core.nekoton.Transport.fromGqlConnection(connection, this._clock);

            const transportData: InitializedTransport = {
              id: params.id,
              group,
              type: 'graphql',
              data: {
                socket,
                connection,
                transport,
              },
            };

            return {
              local: params.data.local === true,
              transportData,
            };
          }
          case 'jrpc': {
            const socket = new JrpcSocket();
            const connection = await socket.connect(params.data);
            const transport = core.nekoton.Transport.fromJrpcConnection(connection, this._clock);

            const transportData: InitializedTransport = {
              id: params.id,
              group,
              type: 'jrpc',
              data: {
                socket,
                connection,
                transport,
              },
            };

            return {
              local: false,
              transportData,
            };
          }
          case 'proto': {
            const socket = new ProtoSocket();
            const connection = await socket.connect(params.data);
            const transport = core.nekoton.Transport.fromProtoConnection(connection, this._clock);

            const transportData: InitializedTransport = {
              id: params.id,
              group,
              type: 'proto',
              data: {
                socket,
                connection,
                transport,
              },
            };

            return {
              local: false,
              transportData,
            };
          }
          case 'proxy': {
            const connection = params.data.connectionFactory.create(this._clock);
            const transportData: InitializedTransport = {
              id: params.id,
              group,
              type: 'proxy',
              data: {
                connection: connection,
                transport: core.nekoton.Transport.fromProxyConnection(connection, this._clock),
              },
            };
            return {
              local: true,
              transportData,
            };
          }
        }
      })();

      try {
        if ((await testTransport(transportData, local)) == TestConnectionResult.CANCELLED) {
          cleanupInitializedTransport(transportData);
          return;
        }
      } catch (e) {
        // Free transport data in case of error
        cleanupInitializedTransport(transportData);
        throw e;
      }

      this._initializedTransport = transportData;
    } catch (e: any) {
      throw new Error(`Failed to create connection: ${e.toString()}`);
    }
  }

  private async _acquireTransport() {
    core.debugLog('_acquireTransport');

    if (this._acquiredTransportCounter > 0) {
      core.debugLog('_acquireTransport -> increase');
      this._acquiredTransportCounter += 1;
    } else {
      this._acquiredTransportCounter = 1;
      if (this._release != null) {
        console.warn('mutex is already acquired');
      } else {
        core.debugLog('_acquireTransport -> await');
        this._release = await this._networkMutex.acquire();
        core.debugLog('_acquireTransport -> create');
      }
    }
  }

  private _releaseTransport() {
    core.debugLog('_releaseTransport');

    this._acquiredTransportCounter -= 1;
    if (this._acquiredTransportCounter <= 0) {
      core.debugLog('_releaseTransport -> release');
      this._release?.();
      this._release = undefined;
    }
  }
}

function cleanupInitializedTransport(transport: InitializedTransport) {
  transport.data.transport.free();
  transport.data.connection.free();
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
export type ConnectionData =
  | { id: number; group?: string; type: 'graphql'; data: GqlSocketParams }
  | { id: number; group?: string; type: 'jrpc'; data: JrpcSocketParams }
  | { id: number; group?: string; type: 'proto'; data: ProtoSocketParams }
  | { id: number; group?: string; type: 'proxy'; data: ProxyParams };

/**
 * @category Client
 */
export type InitializedTransport = { id: number; group: string } & (
  | { type: 'graphql'; data: { socket: GqlSocket; connection: nt.GqlConnection; transport: nt.Transport } }
  | { type: 'jrpc'; data: { socket: JrpcSocket; connection: nt.JrpcConnection; transport: nt.Transport } }
  | { type: 'proto'; data: { socket: ProtoSocket; connection: nt.ProtoConnection; transport: nt.Transport } }
  | { type: 'proxy'; data: { connection: nt.ProxyConnection; transport: nt.Transport } }
);
