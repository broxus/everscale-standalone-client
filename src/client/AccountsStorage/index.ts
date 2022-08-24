import type * as ever from 'everscale-inpage-provider';
import { Address } from 'everscale-inpage-provider';
import type * as nt from 'nekoton-wasm';

import { Keystore } from '../keystore';
import { ConnectionController } from '../ConnectionController';

export { GiverAccount } from './Giver';
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
  fetchPublicKey(ctx: FetchPublicKeyContext): Promise<string>;

  /**
   * Prepares and signs an external message to this account
   *
   * @param args
   * @param ctx
   */
  prepareMessage(args: PrepareMessageParams, ctx: PrepareMessageContext): Promise<nt.SignedMessage>;
}

/**
 * @category AccountsStorage
 */
export type FetchPublicKeyContext = {
  /**
   * Provider clock
   */
  clock: nt.ClockWithOffset,
  /**
   * Connection controller
   */
  connectionController: ConnectionController,
  /**
   * Initialized instance of nekoton-wasm
   */
  nekoton: typeof nt,
};

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
export type PrepareMessageContext = {
  /**
   * Provider clock
   */
  clock: nt.ClockWithOffset,
  /**
   * Provider keystore
   */
  keystore: Keystore,
  /**
   * Connection controller
   */
  connectionController: ConnectionController,
  /**
   * Initialized instance of nekoton-wasm
   */
  nekoton: typeof nt,
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
