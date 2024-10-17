import safeStringify from 'fast-safe-stringify';
import type * as ever from 'everscale-inpage-provider';
import type * as nt from 'nekoton-wasm';

import core from '../core';
import { convertVersionToInt32, SafeEventEmitter } from './utils';
import { ConnectionController, ConnectionProperties, createConnectionController } from './ConnectionController';
import { SubscriptionController } from './SubscriptionController';
import { Account, AccountsStorage, AccountsStorageContext } from './AccountsStorage';
import { Keystore } from './keystore';
import { Clock } from './clock';
export * from './ConnectionController/proxy';

export { NETWORK_PRESETS, ConnectionData, ConnectionProperties } from './ConnectionController';
export { GqlSocketParams, JrpcSocketParams, ConnectionError, checkConnection } from './ConnectionController';
export * from './AccountsStorage';
export { Keystore, Signer, SimpleKeystore } from './keystore';
export { Clock } from './clock';
export type { Ed25519KeyPair } from 'nekoton-wasm';

/**
 * Standalone provider which is used as a fallback when browser extension is not installed
 *
 * @category Client
 */
export type ClientProperties = {
  /**
   * Connection properties or network preset name
   */
  connection?: ConnectionProperties;
  /**
   * Keystore which will be used for all methods with `accountInteraction`
   */
  keystore?: Keystore;
  /**
   * Accounts storage which will be used to send internal messages
   */
  accountsStorage?: AccountsStorage;
  /**
   * Clock object which can be used to adjust time offset
   */
  clock?: Clock;
  /**
   * Message behaviour properties
   */
  message?: MessageProperties;
  /**
   * Explicit params for nekoton wasm loader
   */
  initInput?: nt.InitInput | Promise<nt.InitInput>;
};

/**
 * Message behaviour properties
 *
 * @category Client
 */
export type MessageProperties = {
  /**
   * Number of attempts to send a message
   *
   * @default 5
   */
  retryCount?: number;
  /**
   * Message expiration timeout (seconds)
   *
   * @default 60
   */
  timeout?: number;
  /**
   * Message expiration timeout grow factor for each new retry
   *
   * @default 1.2
   */
  timeoutGrowFactor?: number;
  /**
   * Retry internal transfers (`sendMessage` / `sendMessageDelayed`)
   *
   * @default true
   */
  retryTransfers?: boolean;
};

function validateMessageProperties(message?: MessageProperties): Required<MessageProperties> {
  const m = message || {};
  return {
    retryCount: m.retryCount != null ? Math.max(1, ~~m.retryCount) : 5,
    timeout: m.timeout != null ? Math.max(1, ~~m.timeout) : 60,
    timeoutGrowFactor: m.timeoutGrowFactor || 1.2,
    retryTransfers: true,
  };
}

/**
 * @category Client
 */
export const VERSION = '0.2.25';
/**
 * @category Client
 */
export const SUPPORTED_PERMISSIONS: ever.Permission[] = ['basic', 'accountInteraction'];

/**
 * @category Client
 */
export class EverscaleStandaloneClient extends SafeEventEmitter implements ever.Provider {
  private readonly _context: Context;
  private _handlers: { [K in ever.ProviderMethod]?: ProviderHandler<K> } = {
    requestPermissions,
    changeAccount,
    disconnect,
    subscribe,
    unsubscribe,
    unsubscribeAll,
    getProviderState,
    getFullContractState,
    computeStorageFee,
    getAccountsByCodeHash,
    getTransactions,
    getTransaction,
    findTransaction,
    runLocal,
    executeLocal,
    getExpectedAddress,
    getContractFields,
    unpackInitData,
    getBocHash,
    packIntoCell,
    unpackFromCell,
    extractPublicKey,
    codeToTvc,
    mergeTvc,
    splitTvc,
    setCodeSalt,
    getCodeSalt,
    encodeInternalInput,
    decodeInput,
    decodeOutput,
    decodeEvent,
    decodeTransaction,
    decodeTransactionEvents,
    verifySignature,
    sendUnsignedExternalMessage,
    // addAsset, // not supported
    signData,
    signDataRaw,
    // encryptData, // not supported
    // decryptData, // not supported
    // estimateFees, // not supported
    sendMessage,
    sendMessageDelayed,
    sendExternalMessage,
    sendExternalMessageDelayed,
  };

  public static async create(params: ClientProperties = {}): Promise<EverscaleStandaloneClient> {
    await core.ensureNekotonLoaded(params.initInput);

    // NOTE: capture client inside notify using wrapper object
    const notificationContext: { client?: EverscaleStandaloneClient } = {};

    const notify = <T extends ever.ProviderEvent>(method: T, params: ever.RawProviderEventData<T>) => {
      notificationContext.client?.emit(method, params);
    };

    const clock = new core.nekoton.ClockWithOffset();
    if (params.clock != null) {
      params.clock['impls'].push(clock);
      clock.updateOffset(params.clock.offset);
    }

    try {
      const connectionController =
        params.connection != null ? await createConnectionController(clock, params.connection) : undefined;
      const subscriptionController =
        connectionController != null ? new SubscriptionController(connectionController, notify) : undefined;

      const client = new EverscaleStandaloneClient({
        permissions: {},
        connectionController,
        subscriptionController,
        properties: {
          message: validateMessageProperties(params.message),
        },
        keystore: params.keystore,
        accountsStorage: params.accountsStorage,
        clock,
        notify,
      });
      // NOTE: WeakRef is not working here, so hope it will be garbage collected
      notificationContext.client = client;
      return client;
    } catch (e) {
      if (params.clock != null) {
        params.clock['impls'].pop();
      }

      clock.free();
      throw e;
    }
  }

  public setPollingInterval = (interval: number) => {
    if (this._context.connectionController == null || this._context.subscriptionController == null) {
      throw Error('Connection was not initialized');
    }
    this._context.subscriptionController?.setPollingInterval(interval);
  };

  public static setDebugLogger(logger: (...data: any[]) => void) {
    core.debugLog = logger;
  }

  private constructor(ctx: Context) {
    super();
    this._context = ctx;
  }

  request<T extends ever.ProviderMethod>(req: ever.RawProviderRequest<T>): Promise<ever.RawProviderApiResponse<T>> {
    const handler = this._handlers[req.method] as any as ProviderHandler<T> | undefined;
    if (handler == null) {
      throw invalidRequest(req, `Method '${req.method}' is not supported by standalone provider`);
    }
    return handler(this._context, req);
  }

  addListener<T extends ever.ProviderEvent>(
    eventName: T,
    listener: (data: ever.RawProviderEventData<T>) => void,
  ): this {
    return super.addListener(eventName, listener);
  }

  removeListener<T extends ever.ProviderEvent>(
    eventName: T,
    listener: (data: ever.RawProviderEventData<T>) => void,
  ): this {
    return super.removeListener(eventName, listener);
  }

  on<T extends ever.ProviderEvent>(eventName: T, listener: (data: ever.RawProviderEventData<T>) => void): this {
    return super.on(eventName, listener);
  }

  once<T extends ever.ProviderEvent>(eventName: T, listener: (data: ever.RawProviderEventData<T>) => void): this {
    return super.once(eventName, listener);
  }

  prependListener<T extends ever.ProviderEvent>(
    eventName: T,
    listener: (data: ever.RawProviderEventData<T>) => void,
  ): this {
    return super.prependListener(eventName, listener);
  }

  prependOnceListener<T extends ever.ProviderEvent>(
    eventName: T,
    listener: (data: ever.RawProviderEventData<T>) => void,
  ): this {
    return super.prependOnceListener(eventName, listener);
  }
}

type Context = {
  permissions: Partial<ever.RawPermissions>;
  connectionController?: ConnectionController;
  subscriptionController?: SubscriptionController;
  properties: Properties;
  keystore?: Keystore;
  accountsStorage?: AccountsStorage;
  clock: nt.ClockWithOffset;
  notify: <T extends ever.ProviderEvent>(method: T, params: ever.RawProviderEventData<T>) => void;
};

type Properties = {
  message: Required<MessageProperties>;
};

type ProviderHandler<T extends ever.ProviderMethod> = (
  ctx: Context,
  req: ever.RawProviderRequest<T>,
) => Promise<ever.RawProviderApiResponse<T>>;

const requestPermissions: ProviderHandler<'requestPermissions'> = async (ctx, req) => {
  requireParams(req);

  const { permissions } = req.params;
  requireArray(req, req.params, 'permissions');

  const newPermissions = { ...ctx.permissions };

  for (const permission of permissions) {
    if (permission === 'basic' || (permission as any) === 'tonClient') {
      newPermissions.basic = true;
    } else if (permission === 'accountInteraction') {
      if (newPermissions.accountInteraction != null) {
        continue;
      }
      newPermissions.accountInteraction = await makeAccountInteractionPermission(req, ctx);
    } else {
      throw invalidRequest(req, `Permission '${permission}' is not supported by standalone provider`);
    }
  }

  ctx.permissions = newPermissions;

  // NOTE: be sure to return object copy to prevent adding new permissions
  const permissionsCopy = JSON.parse(JSON.stringify(newPermissions));
  ctx.notify('permissionsChanged', {
    permissions: permissionsCopy,
  });
  return permissionsCopy;
};

const changeAccount: ProviderHandler<'changeAccount'> = async (ctx, req) => {
  requireAccountsStorage(req, ctx);

  const newPermissions = { ...ctx.permissions };

  newPermissions.accountInteraction = await makeAccountInteractionPermission(req, ctx);

  ctx.permissions = newPermissions;

  // NOTE: be sure to return object copy to prevent adding new permissions
  const permissionsCopy = JSON.parse(JSON.stringify(newPermissions));
  ctx.notify('permissionsChanged', {
    permissions: permissionsCopy,
  });
  return permissionsCopy;
};

const disconnect: ProviderHandler<'disconnect'> = async (ctx, _req) => {
  ctx.permissions = {};
  await ctx.subscriptionController?.unsubscribeFromAllContracts();
  ctx.notify('permissionsChanged', { permissions: {} });
  return undefined;
};

const subscribe: ProviderHandler<'subscribe'> = async (ctx, req) => {
  requireParams(req);
  requireConnection(req, ctx);

  const { address, subscriptions } = req.params;
  requireString(req, req.params, 'address');
  requireOptionalObject(req, req.params, 'subscriptions');

  let repackedAddress: string;
  try {
    repackedAddress = core.nekoton.repackAddress(address);
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }

  try {
    return await ctx.subscriptionController.subscribeToContract(repackedAddress, subscriptions);
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const unsubscribe: ProviderHandler<'unsubscribe'> = async (ctx, req) => {
  requireParams(req);
  requireConnection(req, ctx);

  const { address } = req.params;
  requireString(req, req.params, 'address');

  let repackedAddress: string;
  try {
    repackedAddress = core.nekoton.repackAddress(address);
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }

  await ctx.subscriptionController.unsubscribeFromContract(repackedAddress);
  return undefined;
};

const unsubscribeAll: ProviderHandler<'unsubscribeAll'> = async (ctx, _req) => {
  await ctx.subscriptionController?.unsubscribeFromAllContracts();
  return undefined;
};

const getProviderState: ProviderHandler<'getProviderState'> = async (ctx, _req) => {
  const transport = ctx.connectionController?.initializedTransport;

  const version = VERSION;

  return {
    version,
    numericVersion: convertVersionToInt32(version),
    networkId: transport != null ? transport.id : 0,
    selectedConnection: transport != null ? transport.group : '',
    supportedPermissions: [...SUPPORTED_PERMISSIONS],
    permissions: JSON.parse(JSON.stringify(ctx.permissions)),
    subscriptions: ctx.subscriptionController?.subscriptionStates || {},
  };
};

const getFullContractState: ProviderHandler<'getFullContractState'> = async (ctx, req) => {
  requireParams(req);
  requireConnection(req, ctx);

  const { address } = req.params;
  requireString(req, req.params, 'address');

  const { connectionController } = ctx;

  try {
    return connectionController.use(async ({ data: { transport } }) => ({
      state: await transport.getFullContractState(address),
    }));
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const computeStorageFee: ProviderHandler<'computeStorageFee'> = async (ctx, req) => {
  requireParams(req);
  requireConnection(req, ctx);

  const { state, masterchain, timestamp } = req.params;
  requireContractStateBoc(req, req.params, 'state');
  requireOptionalBoolean(req, req.params, 'masterchain');
  requireOptionalNumber(req, req.params, 'timestamp');

  const { connectionController } = ctx;

  try {
    const config = await connectionController.use(({ data: { transport } }) => transport.getBlockchainConfig());
    const utime = timestamp != null ? timestamp : ~~(ctx.clock.nowMs / 1000);
    return core.nekoton.computeStorageFee(config, state.boc, utime, masterchain || false);
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const getAccountsByCodeHash: ProviderHandler<'getAccountsByCodeHash'> = async (ctx, req) => {
  requireParams(req);
  requireConnection(req, ctx);

  const { codeHash, limit, continuation } = req.params;
  requireString(req, req.params, 'codeHash');
  requireOptionalNumber(req, req.params, 'limit');
  requireOptionalString(req, req.params, 'continuation');

  const { connectionController } = ctx;

  try {
    return connectionController.use(({ data: { transport } }) =>
      transport.getAccountsByCodeHash(codeHash, limit || 50, continuation),
    );
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const getTransactions: ProviderHandler<'getTransactions'> = async (ctx, req) => {
  requireParams(req);
  requireConnection(req, ctx);

  const { address, continuation, limit } = req.params;
  requireString(req, req.params, 'address');
  requireOptional(req, req.params, 'continuation', requireTransactionId);
  requireOptionalNumber(req, req.params, 'limit');

  const { connectionController } = ctx;

  try {
    return connectionController.use(({ data: { transport } }) =>
      transport.getTransactions(address, continuation?.lt, limit || 50),
    );
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const getTransaction: ProviderHandler<'getTransaction'> = async (ctx, req) => {
  requireParams(req);
  requireConnection(req, ctx);

  const { hash } = req.params;
  requireString(req, req.params, 'hash');

  const { connectionController } = ctx;

  try {
    return {
      transaction: await connectionController.use(({ data: { transport } }) => transport.getTransaction(hash)),
    };
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const findTransaction: ProviderHandler<'findTransaction'> = async (ctx, req) => {
  requireParams(req);
  requireConnection(req, ctx);

  const { inMessageHash } = req.params;
  requireOptional(req, req.params, 'inMessageHash', requireString);

  const { connectionController } = ctx;

  // TODO: add more filters
  if (inMessageHash == null) {
    return {
      transaction: undefined,
    };
  }

  try {
    return {
      transaction: await connectionController.use(({ data: { transport } }) =>
        transport.getDstTransaction(inMessageHash),
      ),
    };
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const runLocal: ProviderHandler<'runLocal'> = async (ctx, req) => {
  requireParams(req);

  const { address, cachedState, responsible, functionCall, withSignatureId } = req.params;
  requireString(req, req.params, 'address');
  requireOptional(req, req.params, 'cachedState', requireContractState);
  requireOptionalBoolean(req, req.params, 'responsible');
  requireFunctionCall(req, req.params, 'functionCall');
  requireOptionalSignatureId(req, req.params, 'withSignatureId');

  let contractState = cachedState;
  if (contractState == null) {
    requireConnection(req, ctx);
    contractState = await ctx.connectionController.use(async ({ data: { transport } }) =>
      transport.getFullContractState(address),
    );
  }

  if (contractState == null) {
    throw invalidRequest(req, 'Account not found');
  }
  if (!contractState.isDeployed || contractState.lastTransactionId == null) {
    throw invalidRequest(req, 'Account is not deployed');
  }

  const signatureId = await computeSignatureId(req, ctx, withSignatureId);

  try {
    const { output, code } = core.nekoton.runLocal(
      ctx.clock,
      contractState.boc,
      functionCall.abi,
      functionCall.method,
      functionCall.params,
      responsible || false,
      signatureId,
    );
    return { output, code };
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const executeLocal: ProviderHandler<'executeLocal'> = async (ctx, req) => {
  requireParams(req);
  requireConnection(req, ctx);

  const { address, cachedState, stateInit, payload, executorParams, messageHeader } = req.params;
  requireString(req, req.params, 'address');
  requireOptional(req, req.params, 'cachedState', requireContractState);
  requireOptionalString(req, req.params, 'stateInit');
  requireOptionalRawFunctionCall(req, req.params, 'payload');
  requireOptionalObject(req, req.params, 'executorParams');
  requireObject(req, req.params, 'messageHeader');

  const { clock, connectionController } = ctx;

  let repackedAddress: string;
  try {
    repackedAddress = core.nekoton.repackAddress(address);
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }

  const now = ~~(clock.nowMs / 1000);
  const timeout = 60;

  let message: string;
  if (messageHeader.type === 'external') {
    if (payload == null || typeof payload === 'string') {
      message = core.nekoton.createRawExternalMessage(repackedAddress, stateInit, payload, now + timeout).boc;
    } else if (messageHeader.withoutSignature === true) {
      message = core.nekoton.createExternalMessageWithoutSignature(
        clock,
        repackedAddress,
        payload.abi,
        payload.method,
        stateInit,
        payload.params,
        timeout,
      ).boc;
    } else {
      const unsignedMessage = core.nekoton.createExternalMessage(
        clock,
        repackedAddress,
        payload.abi,
        payload.method,
        stateInit,
        payload.params,
        messageHeader.publicKey,
        timeout,
      );

      try {
        if (executorParams?.disableSignatureCheck === true) {
          message = unsignedMessage.signFake().boc;
        } else {
          requireKeystore(req, ctx);
          const signatureId = await computeSignatureId(req, ctx);

          const { keystore } = ctx;

          const signer = await keystore.getSigner(messageHeader.publicKey);
          if (signer == null) {
            throw 'Signer not found for public key';
          }

          const signature = await signer.sign(unsignedMessage.hash, signatureId);
          message = unsignedMessage.sign(signature).boc;
        }
      } catch (e: any) {
        throw invalidRequest(req, e.toString());
      } finally {
        unsignedMessage.free();
      }
    }
  } else if (messageHeader.type === 'internal') {
    requireString(req, messageHeader, 'sender');
    requireString(req, messageHeader, 'amount');
    requireBoolean(req, messageHeader, 'bounce');
    requireOptionalBoolean(req, messageHeader, 'bounced');

    const body =
      payload == null
        ? undefined
        : typeof payload === 'string'
          ? payload
          : core.nekoton.encodeInternalInput(payload.abi, payload.method, payload.params);

    message = core.nekoton.encodeInternalMessage(
      messageHeader.sender,
      repackedAddress,
      messageHeader.bounce,
      stateInit,
      body,
      messageHeader.amount,
    );
  } else {
    throw invalidRequest(req, 'Unknown message type');
  }

  try {
    const [contractState, blockchainConfig, networkDescription] = await connectionController.use(
      ({ data: { transport } }) =>
        Promise.all([
          cachedState == null ? transport.getFullContractState(repackedAddress) : cachedState,
          transport.getBlockchainConfig(),
          transport.getNetworkDescription(),
        ]),
    );

    const account = core.nekoton.makeFullAccountBoc(contractState?.boc);
    const overrideBalance = executorParams?.overrideBalance;

    const result = core.nekoton.executeLocal(
      blockchainConfig,
      account,
      message,
      now,
      executorParams?.disableSignatureCheck === true,
      overrideBalance != null ? overrideBalance.toString() : undefined,
      networkDescription.globalId,
    );
    if ((result as any).exitCode != null) {
      throw new Error(`Contract did not accept the message. Exit code: ${(result as any).exitCode}`);
    }

    const resultVariant = result as { account: string; transaction: nt.Transaction };
    const transaction = resultVariant.transaction;
    const newState = core.nekoton.parseFullAccountBoc(resultVariant.account);

    let output: ever.RawTokensObject | undefined;
    try {
      if (typeof payload === 'object' && typeof payload != null) {
        const decoded = core.nekoton.decodeTransaction(resultVariant.transaction, payload.abi, payload.method);
        output = decoded?.output;
      }
    } catch (_) {
      /* do nothing */
    }

    return {
      transaction,
      newState,
      output,
    };
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const getExpectedAddress: ProviderHandler<'getExpectedAddress'> = async (_ctx, req) => {
  requireParams(req);

  const { tvc, abi, workchain, publicKey, initParams } = req.params;
  requireString(req, req.params, 'tvc');
  requireString(req, req.params, 'abi');
  requireOptionalNumber(req, req.params, 'workchain');
  requireOptionalString(req, req.params, 'publicKey');

  try {
    return core.nekoton.getExpectedAddress(tvc, abi, workchain || 0, publicKey, initParams);
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const getContractFields: ProviderHandler<'getContractFields'> = async (ctx, req) => {
  requireParams(req);

  const { address, abi, cachedState, allowPartial } = req.params;
  requireString(req, req.params, 'address');
  requireString(req, req.params, 'abi');
  requireOptional(req, req.params, 'cachedState', requireContractState);
  requireBoolean(req, req.params, 'allowPartial');

  let repackedAddress: string;
  try {
    repackedAddress = core.nekoton.repackAddress(address);
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }

  let contractState = cachedState;
  if (contractState == null) {
    requireConnection(req, ctx);
    contractState = await ctx.connectionController.use(async ({ data: { transport } }) =>
      transport.getFullContractState(repackedAddress),
    );
  }

  if (contractState == null) {
    return {
      fields: undefined,
      state: undefined,
    };
  }
  if (!contractState.isDeployed || contractState.lastTransactionId == null) {
    return {
      fields: undefined,
      state: contractState,
    };
  }

  try {
    const fields = core.nekoton.unpackContractFields(abi, contractState.boc, allowPartial);
    return {
      fields,
      state: contractState,
    };
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const unpackInitData: ProviderHandler<'unpackInitData'> = async (_ctx, req) => {
  requireParams(req);

  const { abi, data } = req.params;
  requireString(req, req.params, 'abi');
  requireString(req, req.params, 'data');

  try {
    const { publicKey, data: initParams } = core.nekoton.unpackInitData(abi, data);
    return { publicKey, initParams };
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const getBocHash: ProviderHandler<'getBocHash'> = async (_ctx, req) => {
  requireParams(req);

  const { boc } = req.params;
  requireString(req, req.params, 'boc');

  try {
    return { hash: core.nekoton.getBocHash(boc) };
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const packIntoCell: ProviderHandler<'packIntoCell'> = async (_ctx, req) => {
  requireParams(req);

  const { structure, data, abiVersion } = req.params;
  requireArray(req, req.params, 'structure');
  requireOptional(req, req.params, 'abiVersion', requireString);

  try {
    return core.nekoton.packIntoCell(structure as nt.AbiParam[], data, abiVersion);
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const unpackFromCell: ProviderHandler<'unpackFromCell'> = async (_ctx, req) => {
  requireParams(req);

  const { structure, boc, allowPartial, abiVersion } = req.params;
  requireArray(req, req.params, 'structure');
  requireString(req, req.params, 'boc');
  requireBoolean(req, req.params, 'allowPartial');
  requireOptional(req, req.params, 'abiVersion', requireString);

  try {
    return { data: core.nekoton.unpackFromCell(structure as nt.AbiParam[], boc, allowPartial, abiVersion) };
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const extractPublicKey: ProviderHandler<'extractPublicKey'> = async (_ctx, req) => {
  requireParams(req);

  const { boc } = req.params;
  requireString(req, req.params, 'boc');

  try {
    return { publicKey: core.nekoton.extractPublicKey(boc) };
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const codeToTvc: ProviderHandler<'codeToTvc'> = async (_ctx, req) => {
  requireParams(req);

  const { code } = req.params;
  requireString(req, req.params, 'code');

  try {
    const { boc, hash } = core.nekoton.codeToTvc(code);
    return { tvc: boc, hash };
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const mergeTvc: ProviderHandler<'mergeTvc'> = async (_ctx, req) => {
  requireParams(req);

  const { code, data } = req.params;
  requireString(req, req.params, 'code');
  requireString(req, req.params, 'data');

  try {
    const { boc, hash } = core.nekoton.mergeTvc(code, data);
    return { tvc: boc, hash };
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const splitTvc: ProviderHandler<'splitTvc'> = async (_ctx, req) => {
  requireParams(req);

  const { tvc } = req.params;
  requireString(req, req.params, 'tvc');

  try {
    return core.nekoton.splitTvc(tvc);
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const setCodeSalt: ProviderHandler<'setCodeSalt'> = async (_ctx, req) => {
  requireParams(req);

  const { code, salt } = req.params;
  requireString(req, req.params, 'code');
  requireString(req, req.params, 'salt');

  try {
    const { boc, hash } = core.nekoton.setCodeSalt(code, salt);
    return { code: boc, hash };
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const getCodeSalt: ProviderHandler<'getCodeSalt'> = async (_ctx, req) => {
  requireParams(req);

  const { code } = req.params;
  requireString(req, req.params, 'code');

  try {
    return { salt: core.nekoton.getCodeSalt(code) };
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const encodeInternalInput: ProviderHandler<'encodeInternalInput'> = async (_ctx, req) => {
  requireParams(req);

  requireFunctionCall(req, req, 'params');
  const { abi, method, params } = req.params;

  try {
    return { boc: core.nekoton.encodeInternalInput(abi, method, params) };
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const decodeInput: ProviderHandler<'decodeInput'> = async (_ctx, req) => {
  requireParams(req);

  const { body, abi, method, internal } = req.params;
  requireString(req, req.params, 'body');
  requireString(req, req.params, 'abi');
  requireMethodOrArray(req, req.params, 'method');
  requireBoolean(req, req.params, 'internal');

  try {
    return core.nekoton.decodeInput(body, abi, method, internal) || null;
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const decodeOutput: ProviderHandler<'decodeOutput'> = async (_ctx, req) => {
  requireParams(req);

  const { body, abi, method } = req.params;
  requireString(req, req.params, 'body');
  requireString(req, req.params, 'abi');
  requireMethodOrArray(req, req.params, 'method');

  try {
    return core.nekoton.decodeOutput(body, abi, method) || null;
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const decodeEvent: ProviderHandler<'decodeEvent'> = async (_ctx, req) => {
  requireParams(req);

  const { body, abi, event } = req.params;
  requireString(req, req.params, 'body');
  requireString(req, req.params, 'abi');
  requireMethodOrArray(req, req.params, 'event');

  try {
    return core.nekoton.decodeEvent(body, abi, event) || null;
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const decodeTransaction: ProviderHandler<'decodeTransaction'> = async (_ctx, req) => {
  requireParams(req);

  const { transaction, abi, method } = req.params;
  requireString(req, req.params, 'abi');
  requireMethodOrArray(req, req.params, 'method');

  try {
    // NOTE: boc field is not used in decoder
    return core.nekoton.decodeTransaction(transaction as nt.Transaction, abi, method) || null;
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const decodeTransactionEvents: ProviderHandler<'decodeTransactionEvents'> = async (_ctx, req) => {
  requireParams(req);

  const { transaction, abi } = req.params;
  requireString(req, req.params, 'abi');

  try {
    // NOTE: boc field is not used in decoder
    return { events: core.nekoton.decodeTransactionEvents(transaction as nt.Transaction, abi) };
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const verifySignature: ProviderHandler<'verifySignature'> = async (ctx, req) => {
  requireParams(req);

  const { publicKey, dataHash, signature, withSignatureId } = req.params;
  requireString(req, req.params, 'publicKey');
  requireString(req, req.params, 'dataHash');
  requireString(req, req.params, 'signature');
  requireOptionalSignatureId(req, req.params, 'withSignatureId');

  const signatureId = await computeSignatureId(req, ctx, withSignatureId);

  try {
    return { isValid: core.nekoton.verifySignature(publicKey, dataHash, signature, signatureId) };
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const sendUnsignedExternalMessage: ProviderHandler<'sendUnsignedExternalMessage'> = async (ctx, req) => {
  requireParams(req);
  requireConnection(req, ctx);

  const { recipient, stateInit, payload, local, executorParams } = req.params;
  requireString(req, req.params, 'recipient');
  requireOptionalString(req, req.params, 'stateInit');
  requireOptionalRawFunctionCall(req, req.params, 'payload');
  requireOptionalBoolean(req, req.params, 'local');
  requireOptionalObject(req, req.params, 'executorParams');

  let repackedRecipient: string;
  try {
    repackedRecipient = core.nekoton.repackAddress(recipient);
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }

  const { clock, subscriptionController, properties } = ctx;

  const makeSignedMessage = (timeout: number): nt.SignedMessage => {
    try {
      if (typeof payload === 'string' || payload == null) {
        const expireAt = ~~(clock.nowMs / 1000) + timeout;
        return core.nekoton.createRawExternalMessage(repackedRecipient, stateInit, payload, ~~expireAt);
      } else {
        return core.nekoton.createExternalMessageWithoutSignature(
          clock,
          repackedRecipient,
          payload.abi,
          payload.method,
          stateInit,
          payload.params,
          ~~timeout,
        );
      }
    } catch (e: any) {
      throw invalidRequest(req, e.toString());
    }
  };

  const handleTransaction = (transaction: nt.Transaction) => {
    let output: ever.RawTokensObject | undefined;
    try {
      if (typeof payload === 'object' && typeof payload != null) {
        const decoded = core.nekoton.decodeTransaction(transaction, payload.abi, payload.method);
        output = decoded?.output;
      }
    } catch (_) {
      /* do nothing */
    }

    return { transaction, output };
  };

  // Force local execution
  if (local === true) {
    const signedMessage = makeSignedMessage(60);
    const transaction = await subscriptionController.sendMessageLocally(
      repackedRecipient,
      signedMessage,
      executorParams,
    );
    return handleTransaction(transaction);
  }

  // Send and wait with several retries
  let timeout = properties.message.timeout;
  for (let retry = 0; retry < properties.message.retryCount; ++retry) {
    const signedMessage = makeSignedMessage(timeout);

    const transaction = await subscriptionController.sendMessage(repackedRecipient, signedMessage);
    if (transaction == null) {
      timeout *= properties.message.timeoutGrowFactor;
      continue;
    }

    return handleTransaction(transaction);
  }

  // Execute locally
  const errorMessage = 'Message expired';
  const signedMessage = makeSignedMessage(60);
  const transaction = await subscriptionController.sendMessageLocally(repackedRecipient, signedMessage).catch(e => {
    throw invalidRequest(req, `${errorMessage}. ${e.toString()}`);
  });

  const additionalText = transaction.exitCode != null ? `. Possible exit code: ${transaction.exitCode}` : '';
  throw invalidRequest(req, `${errorMessage}${additionalText}`);
};

const signData: ProviderHandler<'signData'> = async (ctx, req) => {
  requireKeystore(req, ctx);
  requireParams(req);

  const { publicKey, data, withSignatureId } = req.params;
  requireString(req, req.params, 'publicKey');
  requireString(req, req.params, 'data');
  requireOptionalSignatureId(req, req.params, 'withSignatureId');

  const signatureId = await computeSignatureId(req, ctx, withSignatureId);

  const { keystore } = ctx;
  const signer = await keystore.getSigner(publicKey);
  if (signer == null) {
    throw invalidRequest(req, 'Signer not found for public key');
  }

  try {
    const dataHash = core.nekoton.getDataHash(data);
    return {
      dataHash,
      ...(await signer.sign(dataHash, signatureId).then(core.nekoton.extendSignature)),
    };
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const signDataRaw: ProviderHandler<'signDataRaw'> = async (ctx, req) => {
  requireKeystore(req, ctx);
  requireParams(req);

  const { publicKey, data, withSignatureId } = req.params;
  requireString(req, req.params, 'publicKey');
  requireString(req, req.params, 'data');
  requireOptionalSignatureId(req, req.params, 'withSignatureId');

  const signatureId = await computeSignatureId(req, ctx, withSignatureId);

  const { keystore } = ctx;
  const signer = await keystore.getSigner(publicKey);
  if (signer == null) {
    throw invalidRequest(req, 'Signer not found for public key');
  }

  try {
    return await signer.sign(data, signatureId).then(core.nekoton.extendSignature);
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const sendMessage: ProviderHandler<'sendMessage'> = async (ctx, req) => {
  requireKeystore(req, ctx);
  requireAccountsStorage(req, ctx);
  requireConnection(req, ctx);
  requireParams(req);

  const { sender, recipient, amount, bounce, payload, stateInit } = req.params;
  requireString(req, req.params, 'sender');
  requireString(req, req.params, 'recipient');
  requireString(req, req.params, 'amount');
  requireBoolean(req, req.params, 'bounce');
  requireOptional(req, req.params, 'payload', requireFunctionCall);
  requireOptionalString(req, req.params, 'stateInit');

  const signatureId = await computeSignatureId(req, ctx);

  const { clock, properties, subscriptionController, connectionController, keystore, accountsStorage } = ctx;

  let repackedSender: string;
  let repackedRecipient: string;
  let account: Account;
  try {
    repackedSender = core.nekoton.repackAddress(sender);
    repackedRecipient = core.nekoton.repackAddress(recipient);
    account = await accountsStorage.getAccount(repackedSender).then(account => {
      if (account != null) {
        return account;
      } else {
        throw new Error('Sender not found');
      }
    });
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }

  const makeSignedMessage = async (timeout: number): Promise<nt.SignedMessage> => {
    try {
      return account.prepareMessage(
        {
          recipient: repackedRecipient,
          amount,
          bounce,
          payload,
          stateInit,
          timeout: ~~timeout,
          signatureId,
        },
        new AccountsStorageContext(clock, connectionController, core.nekoton, keystore),
      );
    } catch (e: any) {
      throw invalidRequest(req, e.toString());
    }
  };

  // Send and wait with several retries
  let timeout = properties.message.timeout;

  // Set `retryCount` if not explicitly disabled
  const retryCount = properties.message.retryTransfers !== false ? properties.message.retryCount : 1;

  for (let retry = 0; retry < retryCount; ++retry) {
    const signedMessage = await makeSignedMessage(timeout);

    const transaction = await subscriptionController.sendMessage(repackedSender, signedMessage);
    if (transaction == null) {
      timeout *= properties.message.timeoutGrowFactor;
      continue;
    }

    return { transaction };
  }

  // Execute locally
  const errorMessage = 'Message expired';
  const signedMessage = await makeSignedMessage(60);
  const transaction = await subscriptionController.sendMessageLocally(repackedSender, signedMessage).catch(e => {
    throw invalidRequest(req, `${errorMessage}. ${e.toString()}`);
  });

  const additionalText = transaction.exitCode != null ? `. Possible exit code: ${transaction.exitCode}` : '';
  throw invalidRequest(req, `${errorMessage}${additionalText}`);
};

const sendMessageDelayed: ProviderHandler<'sendMessageDelayed'> = async (ctx, req) => {
  requireKeystore(req, ctx);
  requireAccountsStorage(req, ctx);
  requireParams(req);
  requireConnection(req, ctx);

  const { sender, recipient, amount, bounce, payload, stateInit } = req.params;
  requireString(req, req.params, 'sender');
  requireString(req, req.params, 'recipient');
  requireString(req, req.params, 'amount');
  requireBoolean(req, req.params, 'bounce');
  requireOptional(req, req.params, 'payload', requireFunctionCall);
  requireOptionalString(req, req.params, 'stateInit');

  const signatureId = await computeSignatureId(req, ctx);

  const { clock, subscriptionController, connectionController, keystore, accountsStorage, notify } = ctx;

  let repackedSender: string;
  let repackedRecipient: string;
  try {
    repackedSender = core.nekoton.repackAddress(sender);
    repackedRecipient = core.nekoton.repackAddress(recipient);
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }

  let signedMessage: nt.SignedMessage;
  try {
    const account = await accountsStorage.getAccount(repackedSender);
    if (account == null) {
      throw new Error('Sender not found');
    }

    signedMessage = await account.prepareMessage(
      {
        recipient: repackedRecipient,
        amount,
        bounce,
        payload,
        stateInit,
        timeout: 60, // TEMP
        signatureId,
      },
      new AccountsStorageContext(clock, connectionController, core.nekoton, keystore),
    );
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }

  subscriptionController
    .sendMessage(repackedSender, signedMessage)
    .then(transaction => {
      notify('messageStatusUpdated', {
        address: repackedSender,
        hash: signedMessage.hash,
        transaction,
      });
    })
    .catch(console.error);

  return {
    message: {
      account: repackedSender,
      hash: signedMessage.hash,
      expireAt: signedMessage.expireAt,
    },
  };
};

const sendExternalMessage: ProviderHandler<'sendExternalMessage'> = async (ctx, req) => {
  requireKeystore(req, ctx);
  requireParams(req);
  requireConnection(req, ctx);

  const { publicKey, recipient, stateInit, payload, local, executorParams } = req.params;
  requireString(req, req.params, 'publicKey');
  requireString(req, req.params, 'recipient');
  requireOptionalString(req, req.params, 'stateInit');
  requireFunctionCall(req, req.params, 'payload');
  requireOptionalBoolean(req, req.params, 'local');
  requireOptionalObject(req, req.params, 'executorParams');

  const signatureId = await computeSignatureId(req, ctx);

  let repackedRecipient: string;
  try {
    repackedRecipient = core.nekoton.repackAddress(recipient);
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }

  const { clock, subscriptionController, keystore, properties } = ctx;
  const signer = await keystore.getSigner(publicKey);
  if (signer == null) {
    throw invalidRequest(req, 'Signer not found for public key');
  }

  const makeSignedMessage = async (timeout: number): Promise<nt.SignedMessage> => {
    let unsignedMessage: nt.UnsignedMessage;
    try {
      unsignedMessage = core.nekoton.createExternalMessage(
        clock,
        repackedRecipient,
        payload.abi,
        payload.method,
        stateInit,
        payload.params,
        publicKey,
        ~~timeout,
      );
    } catch (e: any) {
      throw invalidRequest(req, e.toString());
    }

    try {
      const signature = await signer.sign(unsignedMessage.hash, signatureId);
      return unsignedMessage.sign(signature);
    } catch (e: any) {
      throw invalidRequest(req, e.toString());
    } finally {
      unsignedMessage.free();
    }
  };

  const handleTransaction = (transaction: nt.Transaction) => {
    let output: ever.RawTokensObject | undefined;
    try {
      const decoded = core.nekoton.decodeTransaction(transaction, payload.abi, payload.method);
      output = decoded?.output;
    } catch (_) {
      /* do nothing */
    }

    return { transaction, output };
  };

  // Force local execution
  if (local === true) {
    const signedMessage = await makeSignedMessage(60);
    const transaction = await subscriptionController.sendMessageLocally(
      repackedRecipient,
      signedMessage,
      executorParams,
    );
    return handleTransaction(transaction);
  }

  // Send and wait with several retries
  let timeout = properties.message.timeout;
  for (let retry = 0; retry < properties.message.retryCount; ++retry) {
    const signedMessage = await makeSignedMessage(timeout);

    const transaction = await subscriptionController.sendMessage(repackedRecipient, signedMessage);
    if (transaction == null) {
      timeout *= properties.message.timeoutGrowFactor;
      continue;
    }

    return handleTransaction(transaction);
  }

  // Execute locally
  const errorMessage = 'Message expired';
  const signedMessage = await makeSignedMessage(60);
  const transaction = await subscriptionController.sendMessageLocally(repackedRecipient, signedMessage).catch(e => {
    throw invalidRequest(req, `${errorMessage}. ${e.toString()}`);
  });

  const additionalText = transaction.exitCode != null ? `. Possible exit code: ${transaction.exitCode}` : '';
  throw invalidRequest(req, `${errorMessage}${additionalText}`);
};

const sendExternalMessageDelayed: ProviderHandler<'sendExternalMessageDelayed'> = async (ctx, req) => {
  requireKeystore(req, ctx);
  requireParams(req);
  requireConnection(req, ctx);

  const { publicKey, recipient, stateInit, payload } = req.params;
  requireString(req, req.params, 'publicKey');
  requireString(req, req.params, 'recipient');
  requireOptionalString(req, req.params, 'stateInit');
  requireFunctionCall(req, req.params, 'payload');

  const signatureId = await computeSignatureId(req, ctx);

  let repackedRecipient: string;
  try {
    repackedRecipient = core.nekoton.repackAddress(recipient);
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }

  const { clock, subscriptionController, keystore, properties, notify } = ctx;
  const signer = await keystore.getSigner(publicKey);
  if (signer == null) {
    throw invalidRequest(req, 'Signer not found for public key');
  }

  let unsignedMessage: nt.UnsignedMessage;
  try {
    unsignedMessage = core.nekoton.createExternalMessage(
      clock,
      repackedRecipient,
      payload.abi,
      payload.method,
      stateInit,
      payload.params,
      publicKey,
      ~~properties.message.timeout,
    );
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }

  let signedMessage: nt.SignedMessage;
  try {
    const signature = await signer.sign(unsignedMessage.hash, signatureId);
    signedMessage = unsignedMessage.sign(signature);
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  } finally {
    unsignedMessage.free();
  }

  subscriptionController
    .sendMessage(repackedRecipient, signedMessage)
    .then(transaction => {
      notify('messageStatusUpdated', {
        address: repackedRecipient,
        hash: signedMessage.hash,
        transaction,
      });
    })
    .catch(console.error);

  return {
    message: {
      account: repackedRecipient,
      hash: signedMessage.hash,
      expireAt: signedMessage.expireAt,
    },
  };
};

function requireKeystore(req: any, context: Context): asserts context is Context & { keystore: Keystore } {
  if (context.keystore == null) {
    throw invalidRequest(req, 'Keystore not found');
  }
}

function requireAccountsStorage(
  req: any,
  context: Context,
): asserts context is Context & { accountsStorage: AccountsStorage } {
  if (context.accountsStorage == null) {
    throw invalidRequest(req, 'AccountsStorage not found');
  }
}

function requireConnection(
  req: any,
  context: Context,
): asserts context is Context & {
  connectionController: ConnectionController;
  subscriptionController: SubscriptionController;
} {
  if (context.connectionController == null || context.subscriptionController == null) {
    throw invalidRequest(req, 'Connection was not initialized');
  }
}

async function computeSignatureId(
  req: any,
  ctx: Context,
  withSignatureId?: boolean | number,
): Promise<number | undefined> {
  if (withSignatureId === false) {
    return undefined;
  } else if (typeof withSignatureId === 'number') {
    return withSignatureId;
  } else if (ctx.connectionController == null) {
    return undefined;
  }

  return ctx.connectionController
    .use(async ({ data: { transport } }) => transport.getSignatureId())
    .catch(_ => {
      throw invalidRequest(req, 'Failed to fetch signature id');
    });
}

function requireParams<T extends ever.ProviderMethod>(req: any): asserts req is ever.RawProviderRequest<T> {
  if (req.params == null || typeof req.params !== 'object') {
    throw invalidRequest(req, 'required params object');
  }
}

function requireObject<O, P extends keyof O>(req: ever.RawProviderRequest<ever.ProviderMethod>, object: O, key: P) {
  const property = object[key];
  if (typeof property !== 'object') {
    throw invalidRequest(req, `'${String(key)}' must be an object`);
  }
}

function requireOptionalObject<O, P extends keyof O>(
  req: ever.RawProviderRequest<ever.ProviderMethod>,
  object: O,
  key: P,
) {
  const property = object[key];
  if (property != null && typeof property !== 'object') {
    throw invalidRequest(req, `'${String(key)}' must be an object if specified`);
  }
}

function requireBoolean<O, P extends keyof O>(req: ever.RawProviderRequest<ever.ProviderMethod>, object: O, key: P) {
  const property = object[key];
  if (typeof property !== 'boolean') {
    throw invalidRequest(req, `'${String(key)}' must be a boolean`);
  }
}

function requireOptionalBoolean<O, P extends keyof O>(
  req: ever.RawProviderRequest<ever.ProviderMethod>,
  object: O,
  key: P,
) {
  const property = object[key];
  if (property != null && typeof property !== 'boolean') {
    throw invalidRequest(req, `'${String(key)}' must be a boolean if specified`);
  }
}

function requireString<O, P extends keyof O>(req: ever.RawProviderRequest<ever.ProviderMethod>, object: O, key: P) {
  const property = object[key];
  if (typeof property !== 'string' || property.length === 0) {
    throw invalidRequest(req, `'${String(key)}' must be non-empty string`);
  }
}

function requireOptionalString<O, P extends keyof O>(
  req: ever.RawProviderRequest<ever.ProviderMethod>,
  object: O,
  key: P,
) {
  const property = object[key];
  if (property != null && (typeof property !== 'string' || property.length === 0)) {
    throw invalidRequest(req, `'${String(key)}' must be a non-empty string if provided`);
  }
}

function requireOptionalNumber<O, P extends keyof O>(
  req: ever.RawProviderRequest<ever.ProviderMethod>,
  object: O,
  key: P,
) {
  const property = object[key];
  if (property != null && typeof property !== 'number') {
    throw invalidRequest(req, `'${String(key)}' must be a number if provider`);
  }
}

function requireArray<O, P extends keyof O>(req: ever.RawProviderRequest<ever.ProviderMethod>, object: O, key: P) {
  const property = object[key];
  if (!Array.isArray(property)) {
    throw invalidRequest(req, `'${String(key)}' must be an array`);
  }
}

function requireOptional<O, P extends keyof O>(
  req: ever.RawProviderRequest<ever.ProviderMethod>,
  object: O,
  key: P,
  predicate: (req: ever.RawProviderRequest<ever.ProviderMethod>, object: O, key: P) => void,
) {
  const property = object[key];
  if (property != null) {
    predicate(req, object, key);
  }
}

function requireOptionalSignatureId<O, P extends keyof O>(
  req: ever.RawProviderRequest<ever.ProviderMethod>,
  object: O,
  key: P,
) {
  const property = object[key];
  if (property != null) {
    if (typeof property !== 'boolean' && typeof property !== 'number') {
      throw invalidRequest(req, `'${String(key)}' must be an optional boolean or number`);
    }
  }
}

function requireTransactionId<O, P extends keyof O>(
  req: ever.RawProviderRequest<ever.ProviderMethod>,
  object: O,
  key: P,
) {
  requireObject(req, object, key);
  const property = object[key] as unknown as nt.TransactionId;
  requireString(req, property, 'lt');
  requireString(req, property, 'hash');
}

function requireLastTransactionId<O, P extends keyof O>(
  req: ever.RawProviderRequest<ever.ProviderMethod>,
  object: O,
  key: P,
) {
  requireObject(req, object, key);
  const property = object[key] as unknown as nt.LastTransactionId;
  requireBoolean(req, property, 'isExact');
  requireString(req, property, 'lt');
  requireOptionalString(req, property, 'hash');
}

function requireContractStateBoc<O, P extends keyof O>(
  req: ever.RawProviderRequest<ever.ProviderMethod>,
  object: O,
  key: P,
) {
  requireObject(req, object, key);
  const property = object[key] as unknown as ever.FullContractState;
  requireString(req, property, 'boc');
}

function requireContractState<O, P extends keyof O>(
  req: ever.RawProviderRequest<ever.ProviderMethod>,
  object: O,
  key: P,
) {
  requireObject(req, object, key);
  const property = object[key] as unknown as ever.FullContractState;
  requireString(req, property, 'balance');
  requireOptional(req, property, 'lastTransactionId', requireLastTransactionId);
  requireBoolean(req, property, 'isDeployed');
}

function requireFunctionCall<O, P extends keyof O>(
  req: ever.RawProviderRequest<ever.ProviderMethod>,
  object: O,
  key: P,
) {
  requireObject(req, object, key);
  const property = object[key] as unknown as ever.FunctionCall<string>;
  requireString(req, property, 'abi');
  requireString(req, property, 'method');
  requireObject(req, property, 'params');
}

function requireOptionalRawFunctionCall<O, P extends keyof O>(
  req: ever.RawProviderRequest<ever.ProviderMethod>,
  object: O,
  key: P,
) {
  const property = object[key] as unknown as null | string | ever.FunctionCall<string>;
  if (typeof property === 'string' || property == null) {
    return;
  } else if (typeof property === 'object') {
    requireString(req, property, 'abi');
    requireString(req, property, 'method');
    requireObject(req, property, 'params');
  } else {
    throw invalidRequest(req, `'${String(key)}' must be a function all or optional string`);
  }
}

function requireMethodOrArray<O, P extends keyof O>(
  req: ever.RawProviderRequest<ever.ProviderMethod>,
  object: O,
  key: P,
) {
  const property = object[key];
  if (property != null && typeof property !== 'string' && !Array.isArray(property)) {
    throw invalidRequest(req, `'${String(key)}' must be a method name or an array of possible names`);
  }
}

async function makeAccountInteractionPermission(
  req: ever.RawProviderRequest<ever.ProviderMethod>,
  ctx: Context,
): Promise<ever.Permissions<string>['accountInteraction']> {
  requireAccountsStorage(req, ctx);
  requireConnection(req, ctx);

  const defaultAccount = ctx.accountsStorage.defaultAccount;
  if (defaultAccount == null) {
    throw invalidRequest(req, 'Default account not set in accounts storage');
  }

  const account = await ctx.accountsStorage.getAccount(defaultAccount);
  if (account == null) {
    throw invalidRequest(req, 'Default account not found');
  }

  const publicKey = await account.fetchPublicKey(
    new AccountsStorageContext(ctx.clock, ctx.connectionController, core.nekoton),
  );

  return {
    address: account.address.toString(),
    publicKey,
    contractType: 'unknown' as any,
  };
}

const invalidRequest = (req: ever.RawProviderRequest<ever.ProviderMethod>, message: string, data?: unknown) =>
  new NekotonRpcError(2, `${req.method}: ${message}`, data);

class NekotonRpcError<T> extends Error {
  code: number;
  data?: T;

  constructor(code: number, message: string, data?: T) {
    if (!Number.isInteger(code)) {
      throw new Error('"code" must be an integer');
    }

    if (!message || (typeof message as any) !== 'string') {
      throw new Error('"message" must be a nonempty string');
    }

    super(message);

    this.code = code;
    this.data = data;
  }

  serialize(): JsonRpcError {
    const serialized: JsonRpcError = {
      code: this.code,
      message: this.message,
    };
    if (this.data !== undefined) {
      serialized.data = this.data;
    }
    if (this.stack) {
      serialized.stack = this.stack;
    }
    return serialized;
  }

  toString(): string {
    return safeStringify(this.serialize(), stringifyReplacer, 2);
  }
}

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
  stack?: string;
}

const stringifyReplacer = (_: unknown, value: unknown): unknown => {
  if (value === '[Circular]') {
    return undefined;
  }
  return value;
};
