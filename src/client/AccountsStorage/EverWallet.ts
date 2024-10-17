import type * as nt from 'nekoton-wasm';
import { Address } from 'everscale-inpage-provider';
import BigNumber from 'bignumber.js';

import core from '../../core';
import { Account, PrepareMessageParams, AccountsStorageContext } from './';

/**
 * @category AccountsStorage
 */
export class EverWalletAccount implements Account {
  public readonly address: Address;
  private publicKey?: BigNumber;
  private nonce?: number;
  private isDeployed?: boolean;

  public static async computeAddress(args: {
    publicKey: string | BigNumber;
    workchain?: number;
    /**
     * Optional nonce (uint32) which is appended to the initial data
     */
    nonce?: number;
  }): Promise<Address> {
    // TODO: Somehow propagate init params
    await core.ensureNekotonLoaded();

    const publicKey = args.publicKey instanceof BigNumber ? args.publicKey : new BigNumber(`0x${args.publicKey}`);
    const hash = makeStateInit(publicKey, args.nonce).hash;
    return new Address(`${args.workchain != null ? args.workchain : 0}:${hash}`);
  }

  public static async fromPubkey(args: {
    publicKey: string;
    workchain?: number;
    /**
     * Optional nonce (uint32) which is appended to the initial data
     */
    nonce?: number;
  }): Promise<EverWalletAccount> {
    const publicKey = new BigNumber(`0x${args.publicKey}`);
    const address = await EverWalletAccount.computeAddress({ publicKey, workchain: args.workchain, nonce: args.nonce });
    const result = new EverWalletAccount(address);
    result.publicKey = publicKey;
    result.nonce = args.nonce;
    return result;
  }

  constructor(address: Address) {
    this.address = address;
  }

  async fetchPublicKey(ctx: AccountsStorageContext): Promise<string> {
    let publicKey = this.publicKey;
    if (publicKey == null) {
      publicKey = this.publicKey = await ctx
        .fetchPublicKey(this.address)
        .then(publicKey => new BigNumber(`0x${publicKey}`));
      this.isDeployed = true;
    }
    return publicKey.toString(16).padStart(64, '0');
  }

  async prepareMessage(args: PrepareMessageParams, ctx: AccountsStorageContext): Promise<nt.SignedMessage> {
    const { publicKey, stateInit } = await this.fetchState(ctx);
    const signer = await ctx.getSigner(publicKey);

    const payload = args.payload ? ctx.encodeInternalInput(args.payload) : '';

    let abi: string;
    let method: string;
    let params: nt.TokensObject;
    if (args.stateInit == null) {
      abi = EVER_WALLET_ABI;
      method = 'sendTransaction';
      params = {
        dest: args.recipient,
        value: args.amount,
        bounce: args.bounce,
        flags: 3,
        payload,
      };
    } else {
      abi = EVER_WALLET_ABI_RAW;
      method = 'sendTransactionRaw';
      params = {
        flags: 3,
        message: ctx.encodeInternalMessage({
          dst: args.recipient,
          bounce: args.bounce,
          stateInit: args.stateInit,
          body: payload,
          amount: args.amount,
        }),
      };
    }

    return ctx.createExternalMessage({
      address: this.address,
      signer,
      timeout: args.timeout,
      abi,
      method,
      params,
      stateInit,
      signatureId: args.signatureId,
    });
  }

  private async fetchState(ctx: AccountsStorageContext): Promise<{ publicKey: string; stateInit?: string }> {
    let stateInit: string | undefined = undefined;
    let publicKey: BigNumber;

    if (this.isDeployed === true && this.publicKey != null) {
      publicKey = this.publicKey;
    } else {
      const state = await ctx.getFullContractState(this.address);
      if (state == null || !state.isDeployed) {
        if (this.publicKey == null) {
          throw new Error('Contract not deployed and public key was not specified');
        }

        stateInit = makeStateInit(this.publicKey, this.nonce).boc;
        publicKey = this.publicKey;
      } else {
        this.isDeployed = true;
        publicKey = new BigNumber(`0x${core.nekoton.extractPublicKey(state.boc)}`);
      }

      if (this.publicKey == null) {
        this.publicKey = publicKey;
      }
    }

    return {
      publicKey: publicKey.toString(16).padStart(64, '0'),
      stateInit,
    };
  }
}

const makeStateInit = (publicKey: BigNumber, nonce?: number): { boc: string, hash: string } => {
  let params: nt.AbiParam[], tokens: nt.TokensObject;
  if (nonce != null) {
    params = DATA_STRUCTURE_EXT;
    tokens = {
      publicKey: publicKey.toFixed(0),
      timestamp: 0,
      nonce,
    };
  } else {
    params = DATA_STRUCTURE;
    tokens = {
      publicKey: publicKey.toFixed(0),
      timestamp: 0,
    };
  }

  const data = core.nekoton.packIntoCell(params, tokens).boc;
  return core.nekoton.mergeTvc(EVER_WALLET_CODE, data);
};

const DATA_STRUCTURE: nt.AbiParam[] = [
  { name: 'publicKey', type: 'uint256' },
  { name: 'timestamp', type: 'uint64' },
];
const DATA_STRUCTURE_EXT: nt.AbiParam[] = [
  { name: 'publicKey', type: 'uint256' },
  { name: 'timestamp', type: 'uint64' },
  { name: 'nonce', type: 'uint32' },
];

const EVER_WALLET_CODE =
  'te6cckEBBgEA/AABFP8A9KQT9LzyyAsBAgEgAgMABNIwAubycdcBAcAA8nqDCNcY7UTQgwfXAdcLP8j4KM8WI88WyfkAA3HXAQHDAJqDB9cBURO68uBk3oBA1wGAINcBgCDXAVQWdfkQ8qj4I7vyeWa++COBBwiggQPoqFIgvLHydAIgghBM7mRsuuMPAcjL/8s/ye1UBAUAmDAC10zQ+kCDBtcBcdcBeNcB10z4AHCAEASqAhSxyMsFUAXPFlAD+gLLaSLQIc8xIddJoIQJuZgzcAHLAFjPFpcwcQHLABLM4skB+wAAPoIQFp4+EbqOEfgAApMg10qXeNcB1AL7AOjRkzLyPOI+zYS/';

const EVER_WALLET_ABI = `{
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

const EVER_WALLET_ABI_RAW = `{
  "ABI version": 2,
  "version": "2.3",
  "header": ["pubkey", "time", "expire"],
  "functions": [{
    "name": "sendTransactionRaw",
    "inputs": [
      {"name":"flags","type":"uint8"},
      {"name":"message","type":"cell"}
    ],
    "outputs": [],
    "id": "0x169e3e11"
  }],
  "events": []
}`;
