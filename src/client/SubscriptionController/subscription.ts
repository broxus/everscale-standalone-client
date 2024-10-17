import { Mutex } from '@broxus/await-semaphore';
import type * as nt from 'nekoton-wasm';

import core from '../../core';
import { ConnectionController } from '../ConnectionController';

export class ContractSubscription {
  private readonly _connection: Connection;
  private readonly _address: string;
  private readonly _contract: nt.GenericContract;
  private readonly _contractMutex: Mutex = new Mutex();
  private _releaseTransport?: () => void;
  private _loopPromise?: Promise<void>;
  private _refreshTimer?: [number, () => void];
  private _pollingInterval: number = BACKGROUND_POLLING_INTERVAL;
  private _currentPollingMethod: nt.PollingMethod;
  private _isRunning = false;
  private _currentBlockId?: string;
  private _suggestedBlockId?: string;
  private _skipIteration = false;

  public static async subscribe(
    connectionController: ConnectionController,
    address: string,
    handler: IContractHandler<nt.Transaction>,
  ) {
    const {
      transport: {
        data: { connection, transport },
      },
      release,
    } = await connectionController.acquire();

    try {
      const contract = await transport.subscribeToGenericContract(address, handler);
      if (contract == null) {
        throw new Error(`Failed to subscribe to contract: ${address}`);
      }
      return new ContractSubscription(connection, release, address, contract);
    } catch (e: any) {
      release();
      throw e;
    }
  }

  private constructor(connection: Connection, release: () => void, address: string, contract: nt.GenericContract) {
    this._connection = connection;
    this._address = address;
    this._contract = contract;
    this._releaseTransport = release;
    this._currentPollingMethod = contract.pollingMethod;
  }

  public setPollingInterval(interval: number) {
    this._pollingInterval = interval;
  }

  public async start() {
    if (this._releaseTransport == null) {
      throw new Error('Contract subscription must not be started after being closed');
    }

    if (this._loopPromise) {
      core.debugLog('ContractSubscription -> awaiting loop promise');
      await this._loopPromise;
    }

    core.debugLog('ContractSubscription -> loop started');

    this._loopPromise = (async () => {
      const isSimple = !(this._connection instanceof core.nekoton.GqlConnection);
      const isProxy = this._connection instanceof core.nekoton.ProxyConnection;

      this._isRunning = true;
      let previousPollingMethod = this._currentPollingMethod;
      while (this._isRunning) {
        this._skipIteration = false; // always reset this flag

        const pollingMethodChanged = previousPollingMethod != this._currentPollingMethod;
        previousPollingMethod = this._currentPollingMethod;

        if (isSimple || this._currentPollingMethod == 'manual') {
          this._currentBlockId = undefined;

          core.debugLog('ContractSubscription -> manual -> waiting begins');

          const pollingInterval =
            this._currentPollingMethod == 'manual' || isProxy ? this._pollingInterval : INTENSIVE_POLLING_INTERVAL;

          await new Promise<void>(resolve => {
            const timerHandle = setTimeout(() => {
              this._refreshTimer = undefined;
              resolve();
            }, pollingInterval);
            this._refreshTimer = [timerHandle, resolve];
          });

          core.debugLog('ContractSubscription -> manual -> waiting ends');

          if (this._skipIteration) {
            continue;
          }

          if (!this._isRunning) {
            break;
          }

          core.debugLog('ContractSubscription -> manual -> refreshing begins');

          try {
            this._currentPollingMethod = await this._contractMutex.use(async () => {
              await this._contract.refresh();
              return this._contract.pollingMethod;
            });
          } catch (e: any) {
            core.debugLog(`Error during account refresh (${this._address})`, e);
          }

          core.debugLog('ContractSubscription -> manual -> refreshing ends');
        } else {
          // SAFETY: connection is always GqlConnection here due to `isSimple`
          const connection = this._connection as nt.GqlConnection;

          core.debugLog('ContractSubscription -> reliable start');

          if (pollingMethodChanged && this._suggestedBlockId != null) {
            this._currentBlockId = this._suggestedBlockId;
          }
          this._suggestedBlockId = undefined;

          let nextBlockId: string;
          if (this._currentBlockId == null) {
            core.debugLog('ContractSubscription -> starting reliable connection with unknown block');

            try {
              const latestBlock = await connection.getLatestBlock(this._address);
              this._currentBlockId = latestBlock.id;
              nextBlockId = this._currentBlockId;
            } catch (e: any) {
              core.debugLog(`Failed to get latest block for ${this._address}`, e);
              continue;
            }
          } else {
            try {
              nextBlockId = await connection.waitForNextBlock(this._currentBlockId, this._address, NEXT_BLOCK_TIMEOUT);
            } catch (e: any) {
              core.debugLog(`Failed to wait for next block for ${this._address}`);
              continue; // retry
            }
          }

          try {
            this._currentPollingMethod = await this._contractMutex.use(async () => {
              await this._contract.handleBlock(nextBlockId);
              return this._contract.pollingMethod;
            });
            this._currentBlockId = nextBlockId;
          } catch (e: any) {
            core.debugLog(`Failed to handle block for ${this._address}`, e);
          }
        }
      }

      core.debugLog('ContractSubscription -> loop finished');
    })();
  }

  public skipRefreshTimer(pollingMethod?: nt.PollingMethod) {
    if (pollingMethod != null) {
      this._currentPollingMethod = pollingMethod;
      this._skipIteration = true;
    }
    clearTimeout(this._refreshTimer?.[0]);
    this._refreshTimer?.[1]();
    this._refreshTimer = undefined;
  }

  public async pause() {
    if (!this._isRunning) {
      return;
    }

    this._isRunning = false;

    this.skipRefreshTimer();

    await this._loopPromise;
    this._loopPromise = undefined;

    this._currentPollingMethod = await this._contractMutex.use(async () => {
      return this._contract.pollingMethod;
    });

    this._currentBlockId = undefined;
    this._suggestedBlockId = undefined;
  }

  public async stop() {
    await this.pause();
    this._contract.free();
    this._releaseTransport?.();
    this._releaseTransport = undefined;
  }

  public async prepareReliablePolling() {
    try {
      if (this._connection instanceof core.nekoton.GqlConnection) {
        this._suggestedBlockId = (await this._connection.getLatestBlock(this._address)).id;
      }
    } catch (e: any) {
      throw new Error(`Failed to prepare reliable polling: ${e.toString()}`);
    }
  }

  public async use<T>(f: (contract: nt.GenericContract) => Promise<T>) {
    const release = await this._contractMutex.acquire();
    return f(this._contract)
      .then(res => {
        release();
        return res;
      })
      .catch(err => {
        release();
        throw err;
      });
  }
}

export interface IContractHandler<T extends nt.Transaction> {
  onMessageSent(pendingTransaction: nt.PendingTransaction, transaction: nt.Transaction): void;

  onMessageExpired(pendingTransaction: nt.PendingTransaction): void;

  onStateChanged(newState: nt.ContractState): void;

  onTransactionsFound(transactions: Array<T>, info: nt.TransactionsBatchInfo): void;
}

type Connection = nt.GqlConnection | nt.JrpcConnection | nt.ProtoConnection | nt.ProxyConnection;

const NEXT_BLOCK_TIMEOUT = 60; // 60s
const INTENSIVE_POLLING_INTERVAL = 2000; // 2s
const BACKGROUND_POLLING_INTERVAL = 60000;
