import type * as nt from 'nekoton-wasm';
import { Address, TokensObject } from 'everscale-inpage-provider';

import { Account, PrepareMessageParams, AccountsStorageContext } from './';

type GenericAccountCall = {
  method: string;
  params: TokensObject<string>;
  stateInit?: string;
};

type PrepareMessage = (args: PrepareMessageParams, ctx: AccountsStorageContext) => Promise<GenericAccountCall>;

/**
 * @category AccountsStorage
 */
export class GenericAccount implements Account {
  public readonly address: Address;
  private readonly abi: string;
  private readonly prepareMessageImpl: PrepareMessage;
  private publicKey?: string;

  constructor(args: {
    address: string | Address;
    abi: object | string;
    prepareMessage: PrepareMessage;
    publicKey?: string;
  }) {
    this.address = args.address instanceof Address ? args.address : new Address(args.address);
    this.abi = typeof args.abi === 'string' ? args.abi : JSON.stringify(args.abi);
    this.prepareMessageImpl = args.prepareMessage;
    this.publicKey = args.publicKey;
  }

  public async fetchPublicKey(ctx: AccountsStorageContext): Promise<string> {
    if (this.publicKey != null) {
      return this.publicKey;
    }
    this.publicKey = await ctx.fetchPublicKey(this.address);
    return this.publicKey;
  }

  async prepareMessage(args: PrepareMessageParams, ctx: AccountsStorageContext): Promise<nt.SignedMessage> {
    const publicKey = await this.fetchPublicKey(ctx);
    const signer = await ctx.getSigner(publicKey);

    const { method, params, stateInit } = await this.prepareMessageImpl(args, ctx);

    return ctx.createExternalMessage({
      address: this.address,
      signer,
      timeout: args.timeout,
      abi: this.abi,
      method,
      params,
      stateInit,
    });
  }
}

/**
 * @category AccountsStorage
 */
export class MsigAccount extends GenericAccount {
  constructor(args: { address: string | Address; publicKey?: string; type: 'SafeMultisig' | 'multisig2' }) {
    super({
      address: args.address,
      publicKey: args.publicKey,
      abi: args.type == 'multisig2' ? MSIG2_ABI : MSIG_ABI,
      prepareMessage: async (args, ctx) => {
        const payload = args.payload ? ctx.encodeInternalInput(args.payload) : '';
        return {
          method: 'sendTransaction',
          params: {
            dest: args.recipient,
            value: args.amount,
            bounce: args.bounce,
            flags: 3,
            payload,
          },
        };
      },
    });
  }
}

const MSIG_ABI = `{
  "ABI version": 2,
  "header": ["pubkey", "time", "expire"],
  "functions": [{
    "name": "sendTransaction",
    "inputs": [
      {"name":"dest","type":"address"},
      {"name":"value","type":"uint128"},
      {"name":"bounce","type":"bool"},
      {"name":"flags","type":"uint8"},
      {"name":"payload","type":"cell"}
    ],
    "outputs": []
  }],
  "events": []
}`;

const MSIG2_ABI = `{
  "ABI version": 2,
  "version": "2.3",
  "header": ["pubkey", "time", "expire"],
  "functions": [{
    "name": "sendTransaction",
    "inputs": [
      {"name":"dest","type":"address"},
      {"name":"value","type":"uint128"},
      {"name":"bounce","type":"bool"},
      {"name":"flags","type":"uint8"},
      {"name":"payload","type":"cell"}
    ],
    "outputs": []
  }],
  "events": []
}`;
