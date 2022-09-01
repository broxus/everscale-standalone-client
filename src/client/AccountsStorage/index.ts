import type * as ever from 'everscale-inpage-provider';
import { AbiVersion, Address } from 'everscale-inpage-provider';
import type * as nt from 'nekoton-wasm';

import { Keystore, Signer } from '../keystore';
import { ConnectionController } from '../ConnectionController';

export { GiverAccount } from './Giver';
export { GenericAccount, MsigAccount } from './Generic';
export { WalletV3Account } from './WalletV3';
export { HighloadWalletV2 } from './HighloadWalletV2';

/**
 * @category AccountsStorage
 */
export interface AccountsStorage {
  /**
   * Selected default account
   */
  defaultAccount: Address | undefined;

  /**
   * Returns account for given address
   * @param address: account address
   */
  getAccount(address: string | Address): Promise<Account | undefined>;
}

/**
 * @category AccountsStorage
 */
export interface Account {
  /**
   * Account contract address
   */
  readonly address: Address;

  /**
   * Fetch contract public key
   */
  fetchPublicKey(ctx: AccountsStorageContext): Promise<string>;

  /**
   * Prepares and signs an external message to this account
   *
   * @param args
   * @param ctx
   */
  prepareMessage(args: PrepareMessageParams, ctx: AccountsStorageContext): Promise<nt.SignedMessage>;
}

/**
 * @category AccountsStorage
 */
export type PrepareMessageParams = {
  /**
   * Message destination address
   */
  recipient: string;
  /**
   * Optional base64 encoded `.tvc` file.
   *
   * NOTE: Not guaranteed to be supported
   */
  stateInit?: string;
  /**
   * Amount of nano EVER to send
   */
  amount: string;
  /**
   * Whether to bounce message back on error
   */
  bounce: boolean;
  /**
   * Optional function call
   */
  payload?: ever.FunctionCall<string>;
  /**
   * External message timeout
   */
  timeout: number;
};

/**
 * @category AccountsStorage
 */
export class AccountsStorageContext {
  constructor(
    private readonly clock: nt.ClockWithOffset,
    private readonly connectionController: ConnectionController,
    private readonly nekoton: typeof nt,
    private readonly keystore?: Keystore,
  ) {
  }

  public async getSigner(publicKey: string): Promise<Signer> {
    if (this.keystore == null) {
      throw new Error('Keystore not found');
    }
    const signer = await this.keystore.getSigner(publicKey);
    if (signer == null) {
      throw new Error('Signer not found');
    }
    return signer;
  }

  public get nowMs(): number {
    return this.clock.nowMs;
  }

  public get nowSec(): number {
    return ~~(this.clock.nowMs / 1000);
  }

  public async fetchPublicKey(address: string | Address): Promise<string> {
    const state = await this.getFullContractState(address);
    if (state == null || !state.isDeployed) {
      throw new Error('Contract not deployed');
    }
    return this.nekoton.extractPublicKey(state.boc);
  }

  public async getFullContractState(address: string | Address): Promise<nt.FullContractState | undefined> {
    return this.connectionController.use(async ({ data: { transport } }) =>
      transport.getFullContractState(address.toString()));
  }

  public extractContractData(boc: string): string | undefined {
    return this.nekoton.extractContractData(boc);
  }

  public packIntoCell(args: {
    structure: nt.AbiParam[],
    data: nt.TokensObject,
    abiVersion?: AbiVersion
  }): string {
    return this.nekoton.packIntoCell(args.structure, args.data, args.abiVersion);
  }

  public unpackFromCell(args: {
    structure: nt.AbiParam[],
    boc: string,
    allowPartial: boolean,
    abiVersion?: AbiVersion
  }): nt.TokensObject {
    return this.nekoton.unpackFromCell(args.structure, args.boc, args.allowPartial, args.abiVersion);
  }

  public getBocHash(boc: string): string {
    return this.nekoton.getBocHash(boc);
  }

  public extendSignature(signature: string): nt.ExtendedSignature {
    return this.nekoton.extendSignature(signature);
  }

  public encodeInternalInput(args: ever.FunctionCall<string>): string {
    return this.nekoton.encodeInternalInput(args.abi, args.method, args.params);
  }

  public encodeInternalMessage(args: {
    src?: string,
    dst: string,
    bounce: boolean,
    stateInit?: string,
    body?: string,
    amount: string,
  }): string {
    return this.nekoton.encodeInternalMessage(
      args.src,
      args.dst,
      args.bounce,
      args.stateInit,
      args.body,
      args.amount,
    );
  }

  public async createExternalMessage(args: {
    address: string | Address,
    signer: Signer,
    timeout: number,
    abi: string,
    method: string,
    params: nt.TokensObject,
    stateInit?: string,
  }): Promise<nt.SignedMessage> {
    const unsignedMessage = this.nekoton.createExternalMessage(
      this.clock,
      args.address.toString(),
      args.abi,
      args.method,
      args.stateInit,
      args.params,
      args.signer.publicKey,
      args.timeout,
    );

    try {
      const signature = await args.signer.sign(unsignedMessage.hash);
      return unsignedMessage.sign(signature);
    } finally {
      unsignedMessage.free();
    }
  }

  public createRawExternalMessage(args: {
    address: string | Address,
    body?: string,
    stateInit?: string,
    expireAt: number
  }): nt.SignedMessage {
    return this.nekoton.createRawExternalMessage(
      args.address.toString(),
      args.stateInit,
      args.body,
      args.expireAt,
    );
  }
}

/**
 * @category AccountsStorage
 */
export class SimpleAccountsStorage implements AccountsStorage {
  private _defaultAccount: Address | undefined;
  private readonly accounts: Map<string, Account> = new Map();

  /**
   * Creates new simple accounts storage.
   *
   * If no `defaultAccount` provided, uses first provided entry
   *
   * @param args
   */
  constructor(args: { defaultAccount?: Address | string, entries?: Iterable<Account> } = {}) {
    if (args.entries != null) {
      for (const account of args.entries) {
        if (this._defaultAccount == null) {
          this._defaultAccount = account.address;
        }
        this.accounts.set(account.address.toString(), account);
      }
    }

    if (args.defaultAccount != null) {
      let defaultAccount: Address;
      if (args.defaultAccount instanceof Address) {
        defaultAccount = args.defaultAccount;
      } else {
        defaultAccount = new Address(args.defaultAccount);
      }

      if (!this.accounts.has(defaultAccount.toString())) {
        throw new Error('Provided default account not found in storage');
      }
      this._defaultAccount = defaultAccount;
    }
  }

  public get defaultAccount(): Address | undefined {
    return this._defaultAccount;
  }

  public set defaultAccount(value: Address | string | undefined) {
    const address = value?.toString();
    if (address != null && !this.accounts.has(address)) {
      throw new Error('Account not found in storage');
    }
    this._defaultAccount = (value == null || value instanceof Address) ? value : new Address(value);
  }

  public async getAccount(address: string | Address): Promise<Account | undefined> {
    return this.accounts.get(address.toString());
  }

  public addAccount(account: Account): Address {
    const address = account.address;
    this.accounts.set(address.toString(), account);
    return address;
  }

  public hasAccount(address: string | Address): boolean {
    return this.accounts.has(address.toString());
  }

  public removeAccount(address: string | Address) {
    this.accounts.delete(address.toString());
  }
}
