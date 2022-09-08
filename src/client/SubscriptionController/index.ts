import { Mutex } from '@broxus/await-semaphore';
import type * as ever from 'everscale-inpage-provider';
import type * as nt from 'nekoton-wasm';

import { getUniqueId } from '../utils';
import { ConnectionController } from '../ConnectionController';
import { ContractSubscription, IContractHandler } from './subscription';

const DEFAULT_POLLING_INTERVAL = 10000; // 10s

export class SubscriptionController {
  private readonly _connectionController: ConnectionController;
  private readonly _notify: <T extends ever.ProviderEvent>(method: T, params: ever.RawProviderEventData<T>) => void;

  private readonly _subscriptions: Map<string, ContractSubscription> = new Map();
  private readonly _subscriptionsMutex: Mutex = new Mutex();
  private readonly _sendMessageRequests: Map<string, Map<string, SendMessageCallback>> = new Map();
  private readonly _subscriptionStates: Map<string, SubscriptionState> = new Map();

  constructor(
    connectionController: ConnectionController,
    notify: <T extends ever.ProviderEvent>(method: T, params: ever.RawProviderEventData<T>) => void,
  ) {
    this._connectionController = connectionController;
    this._notify = notify;
  }

  public async sendMessageLocally(
    address: string,
    signedMessage: nt.SignedMessage,
  ): Promise<nt.Transaction> {
    const subscriptionId = getUniqueId();
    try {
      await this.subscribeToContract(address, { state: true }, subscriptionId);
      const subscription = this._subscriptions.get(address);
      if (subscription == null) {
        throw new Error('Failed to subscribe to contract');
      }

      return await subscription.use((contract) =>
        contract.sendMessageLocally(signedMessage));
    } finally {
      this.unsubscribeFromContract(address, subscriptionId).catch(console.error);
    }
  }

  public sendMessage(address: string, signedMessage: nt.SignedMessage): Promise<nt.Transaction | undefined> {
    let messageRequests = this._sendMessageRequests.get(address);
    if (messageRequests == null) {
      messageRequests = new Map();
      this._sendMessageRequests.set(address, messageRequests);
    }

    const subscriptionId = getUniqueId();
    return new Promise<nt.Transaction | undefined>((resolve, reject) => {
      const id = signedMessage.hash;
      messageRequests!.set(id, { resolve, reject });

      this.subscribeToContract(address, { state: true }, subscriptionId)
        .then(async () => {
          const subscription = this._subscriptions.get(address);
          if (subscription == null) {
            throw new Error('Failed to subscribe to contract');
          }

          await subscription.prepareReliablePolling();
          await subscription
            .use(async (contract) => {
              await contract.sendMessage(signedMessage);
              subscription.skipRefreshTimer();
            });
        })
        .catch((e: any) => this._rejectMessageRequest(address, id, e))
        .finally(() => {
          this.unsubscribeFromContract(address, subscriptionId).catch(console.error);
        });
    });
  }

  public async subscribeToContract(
    address: string,
    params: Partial<ever.ContractUpdatesSubscription>,
    internalId?: number,
  ): Promise<ever.ContractUpdatesSubscription> {
    return this._subscriptionsMutex.use(async () => {
      let mergeInputParams = (currentParams: ever.ContractUpdatesSubscription): ever.ContractUpdatesSubscription => {
        const newParams = { ...currentParams };
        Object.keys(newParams).map((param) => {
          if (param !== 'state' && param !== 'transactions') {
            throw new Error(`Unknown subscription topic: ${param}`);
          }

          const value = params[param];
          if (typeof value === 'boolean') {
            newParams[param] = value;
          } else if (value == null) {
            return;
          } else {
            throw new Error(`Unknown subscription topic value ${param}: ${value}`);
          }
        });
        return newParams;
      };

      const subscriptionState = this._subscriptionStates.get(address) || makeDefaultSubscriptionState();
      let changedParams: ever.ContractUpdatesSubscription;
      if (internalId == null) {
        // Client subscription without id
        // Changed params are `SubscriptionState.client`
        changedParams = mergeInputParams(subscriptionState.client);
      } else {
        // Internal subscription with id
        // Changed params are `SubscriptionState.internal[internalId]`
        let exisingParams = subscriptionState.internal.get(internalId);
        if (exisingParams != null) {
          // Updating existing internal params
          changedParams = mergeInputParams(exisingParams);

          // Remove entry if it is empty
          if (isEmptySubscription(changedParams)) {
            subscriptionState.internal.delete(internalId);
          }
        } else {
          // Merge input params with empty struct
          changedParams = mergeInputParams({ state: false, transactions: false });
        }
      }

      // Merge changed params with the rest of internal params
      let computedParams = { ...changedParams };
      for (const params of subscriptionState.internal.values()) {
        computedParams.state ||= params.state;
        computedParams.transactions ||= params.transactions;
      }

      // Remove subscription if all params are empty
      if (isEmptySubscription(computedParams)) {
        this._subscriptionStates.delete(address);
        await this._tryUnsubscribe(address);
        return { ...computedParams };
      }

      // Create subscription if it doesn't exist
      let existingSubscription = this._subscriptions.get(address);
      const isNewSubscription = existingSubscription == null;
      if (existingSubscription == null) {
        existingSubscription = await this._createSubscription(address);
      }

      // Update subscription state
      if (internalId == null) {
        // Update client params
        subscriptionState.client = changedParams;
      } else {
        // Set new internal params
        subscriptionState.internal.set(internalId, changedParams);
      }
      this._subscriptionStates.set(address, subscriptionState);

      // Start subscription
      if (isNewSubscription) {
        await existingSubscription.start();
      }

      // Returns only changed params
      return { ...changedParams };
    });
  }

  public async unsubscribeFromContract(address: string, internalId?: number) {
    await this.subscribeToContract(address, {
      state: false,
      transactions: false,
    }, internalId);
  }

  public async unsubscribeFromAllContracts(internalId?: number) {
    for (const address of this._subscriptions.keys()) {
      await this.unsubscribeFromContract(address, internalId);
    }
  }

  public get subscriptionStates(): { [address: string]: ever.ContractUpdatesSubscription } {
    const result: { [address: string]: ever.ContractUpdatesSubscription } = {};
    for (const [key, value] of this._subscriptionStates.entries()) {
      result[key] = { ...value.client };
    }
    return result;
  }

  private async _createSubscription(address: string) {
    class ContractHandler implements IContractHandler<nt.Transaction> {
      private readonly _address: string;
      private readonly _controller: SubscriptionController;
      private _enabled = false;

      constructor(address: string, controller: SubscriptionController) {
        this._address = address;
        this._controller = controller;
      }

      public enabledNotifications() {
        this._enabled = true;
      }

      onMessageExpired(pendingTransaction: nt.PendingTransaction) {
        if (this._enabled) {
          this._controller
            ._resolveMessageRequest(this._address, pendingTransaction.messageHash, undefined)
            .catch(console.error);
        }
      }

      onMessageSent(pendingTransaction: nt.PendingTransaction, transaction: nt.Transaction) {
        if (this._enabled) {
          this._controller
            ._resolveMessageRequest(this._address, pendingTransaction.messageHash, transaction)
            .catch(console.error);
        }
      }

      onStateChanged(newState: nt.ContractState) {
        if (this._enabled) {
          this._controller._notifyStateChanged(this._address, newState);
        }
      }

      onTransactionsFound(transactions: Array<nt.Transaction>, info: nt.TransactionsBatchInfo) {
        if (this._enabled) {
          this._controller._notifyTransactionsFound(this._address, transactions, info);
        }
      }
    }

    const handler = new ContractHandler(address, this);

    const subscription = await ContractSubscription.subscribe(this._connectionController, address, handler);
    subscription.setPollingInterval(DEFAULT_POLLING_INTERVAL);
    handler.enabledNotifications();

    this._subscriptions.set(address, subscription);

    return subscription;
  }

  private async _tryUnsubscribe(address: string) {
    const subscriptionState = this._subscriptionStates.get(address);
    const sendMessageRequests = this._sendMessageRequests.get(address);
    if (subscriptionState == null && (sendMessageRequests?.size || 0) == 0) {
      const subscription = this._subscriptions.get(address);
      this._subscriptions.delete(address);
      await subscription?.stop();
    }
  }

  private async _rejectMessageRequest(address: string, id: string, error: Error) {
    this._deleteMessageRequestAndGetCallback(address, id).reject(error);
    await this._subscriptionsMutex.use(async () => this._tryUnsubscribe(address));
  }

  private async _resolveMessageRequest(address: string, id: string, transaction?: nt.Transaction) {
    this._deleteMessageRequestAndGetCallback(address, id).resolve(transaction);
    await this._subscriptionsMutex.use(async () => this._tryUnsubscribe(address));
  }

  private _notifyStateChanged(address: string, state: nt.ContractState) {
    const subscriptionState = this._subscriptionStates.get(address);
    if (subscriptionState?.client.state) {
      this._notify('contractStateChanged', {
        address,
        state,
      });
    }
  }

  private _notifyTransactionsFound(address: string, transactions: nt.Transaction[], info: nt.TransactionsBatchInfo) {
    const subscriptionState = this._subscriptionStates.get(address);
    if (subscriptionState?.client.transactions) {
      this._notify('transactionsFound', {
        address,
        transactions,
        info,
      });
    }
  }

  private _deleteMessageRequestAndGetCallback(address: string, id: string): SendMessageCallback {
    const callbacks = this._sendMessageRequests.get(address)?.get(id);
    if (!callbacks) {
      throw new Error(`SendMessage request with id '${id}' not found`);
    }

    this._deleteMessageRequest(address, id);
    return callbacks;
  }

  private _deleteMessageRequest(address: string, id: string) {
    const accountMessageRequests = this._sendMessageRequests.get(address);
    if (!accountMessageRequests) {
      return;
    }
    accountMessageRequests.delete(id);
    if (accountMessageRequests.size == 0) {
      this._sendMessageRequests.delete(address);
    }
  }
}

type SubscriptionState = {
  internal: Map<number, ever.ContractUpdatesSubscription>,
  client: ever.ContractUpdatesSubscription,
};

const makeDefaultSubscriptionState = (): SubscriptionState => ({
  internal: new Map(),
  client: {
    state: false,
    transactions: false,
  },
});

const isEmptySubscription = (params: ever.ContractUpdatesSubscription) =>
  !params.state && !params.transactions;

export type SendMessageCallback = {
  resolve: (transaction?: nt.Transaction) => void;
  reject: (error?: Error) => void;
};
