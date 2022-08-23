import type * as ever from 'everscale-inpage-provider';
import type * as nt from 'nekoton-wasm';

import { Keystore } from '../keystore';
import { ConnectionController } from '../ConnectionController';

export { GiverAccount } from './giver';

/**
 * @category AccountsStorage
 */
export interface AccountsStorage {
  /**
   * Selected default account
   */
  defaultAccount: string | undefined;

  /**
   * Returns account for given address
   * @param address: account address
   */
  getAccount(address: string): Promise<Account | undefined>;
}

/**
 * @category AccountsStorage
 */
export interface Account {
  /**
   * Account contract address
   */
  readonly address: string;

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
  private _defaultAccount: string | undefined;
  private readonly accounts: Map<string, Account> = new Map();

  /**
   * Creates new simple accounts storage.
   *
   * If no `defaultAccount` provided, uses first provided entry
   *
   * @param args
   */
  constructor(args: { defaultAccount?: string, entries?: Iterable<Account> } = {}) {
    if (args.entries != null) {
      for (const account of args.entries) {
        if (this._defaultAccount == null) {
          this._defaultAccount = account.address;
        }
        this.accounts.set(account.address, account);
      }
    }

    if (args.defaultAccount != null) {
      if (!this.accounts.has(args.defaultAccount)) {
        throw new Error('Provided default account not found in storage');
      }
      this._defaultAccount = args.defaultAccount;
    }
  }

  public get defaultAccount(): string | undefined {
    return this._defaultAccount;
  }

  public set defaultAccount(value) {
    if (value != null && !this.accounts.has(value)) {
      throw new Error('Account not found in storage');
    }
    this._defaultAccount = value;
  }

  public async getAccount(address: string): Promise<Account | undefined> {
    return this.accounts.get(address);
  }

  public addAccount(account: Account) {
    this.accounts.set(account.address, account);
  }

  public hasAccount(address: string): boolean {
    return this.accounts.has(address);
  }

  public removeAccount(address: string) {
    this.accounts.delete(address);
  }
}
