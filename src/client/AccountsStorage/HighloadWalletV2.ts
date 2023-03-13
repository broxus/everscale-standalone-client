import type * as nt from 'nekoton-wasm';
import { Address } from 'everscale-inpage-provider';
import BigNumber from 'bignumber.js';

import core from '../../core';
import { Account, PrepareMessageParams, AccountsStorageContext } from './';
import { convertToAddressObject } from '../utils';

const { ensureNekotonLoaded, nekoton } = core;

/**
 * @category AccountsStorage
 */
export class HighloadWalletV2 implements Account {
  public readonly address: Address;
  private publicKey?: BigNumber;

  public static async computeAddress(args: { publicKey: string | BigNumber; workchain?: number }): Promise<Address> {
    // TODO: Somehow propagate init params
    await ensureNekotonLoaded();

    const publicKey = args.publicKey instanceof BigNumber ? args.publicKey : new BigNumber(`0x${args.publicKey}`);
    const hash = makeStateInit(publicKey).hash;
    return new Address(`${args.workchain != null ? args.workchain : 0}:${hash}`);
  }

  public static async fromPubkey(args: { publicKey: string; workchain?: number }): Promise<HighloadWalletV2> {
    const publicKey = new BigNumber(`0x${args.publicKey}`);
    const address = await HighloadWalletV2.computeAddress({ publicKey, workchain: args.workchain });
    const result = new HighloadWalletV2(address);
    result.publicKey = publicKey;
    return result;
  }

  constructor(address: string | Address) {
    this.address = convertToAddressObject(address);
  }

  async fetchPublicKey(ctx: AccountsStorageContext): Promise<string> {
    let publicKey = this.publicKey;
    if (publicKey == null) {
      publicKey = this.publicKey = await ctx
        .fetchPublicKey(this.address)
        .then(publicKey => new BigNumber(`0x${publicKey}`));
    }
    return publicKey.toString(16).padStart(64, '0');
  }

  async prepareMessage(args: PrepareMessageParams, ctx: AccountsStorageContext): Promise<nt.SignedMessage> {
    const { publicKey, stateInit } = await this.fetchState(ctx);
    const signer = await ctx.getSigner(publicKey);

    const expireAt = ctx.nowSec + args.timeout;

    const attachedPayload = args.payload ? ctx.encodeInternalInput(args.payload) : undefined;

    const internalMessage = ctx.encodeInternalMessage({
      dst: args.recipient,
      bounce: args.bounce,
      stateInit: args.stateInit,
      body: attachedPayload,
      amount: args.amount,
    });

    const params: nt.TokensObject = {
      messages: [
        [
          0,
          {
            flags: 3,
            message: internalMessage,
          },
        ],
      ],
    };

    const { boc: messages, hash: messagesHash } = ctx.packIntoCell({ structure: MESSAGES_STRUCTURE, data: params });

    params.walletId = WALLET_ID;
    params.expireAt = expireAt;
    params.messagesHash = `0x${messagesHash.slice(-8)}`;

    const hash = ctx.packIntoCell({ structure: UNSIGNED_TRANSFER_STRUCTURE, data: params }).hash;
    const signature = await signer.sign(hash, args.signatureId);
    const { signatureParts } = ctx.extendSignature(signature);

    params.signatureHigh = signatureParts.high;
    params.signatureLow = signatureParts.low;
    const signedPayload = ctx.packIntoCell({ structure: SIGNED_TRANSFER_STRUCTURE, data: params }).boc;

    return ctx.createRawExternalMessage({
      address: this.address.toString(),
      body: signedPayload,
      stateInit,
      expireAt,
    });
  }

  private async fetchState(ctx: AccountsStorageContext): Promise<{
    publicKey: string;
    stateInit?: string;
  }> {
    let stateInit: string | undefined = undefined;
    let publicKey: BigNumber;
    const state = await ctx.getFullContractState(this.address);
    if (state == null || !state.isDeployed) {
      if (this.publicKey == null) {
        throw new Error('Contract not deployed and public key was not specified');
      }

      stateInit = makeStateInit(this.publicKey).boc;
      publicKey = this.publicKey;
    } else if (this.publicKey == null) {
      const data = ctx.extractContractData(state.boc);
      if (data == null) {
        throw new Error('Failed to extract contract data');
      }
      publicKey = parseInitData(ctx, data).publicKey;
    } else {
      publicKey = this.publicKey;
    }

    if (this.publicKey == null) {
      this.publicKey = publicKey;
    }

    return {
      publicKey: publicKey.toString(16).padStart(64, '0'),
      stateInit,
    };
  }
}

const parseInitData = (ctx: AccountsStorageContext, boc: string): { publicKey: BigNumber } => {
  const parsed = ctx.unpackFromCell({ structure: DATA_STRUCTURE, boc, allowPartial: true });
  if (typeof parsed !== 'object' || typeof parsed['publicKey'] !== 'string') {
    throw new Error('Invalid contract data');
  }
  return {
    publicKey: new BigNumber(parsed.publicKey),
  };
};

const makeStateInit = (publicKey: BigNumber): { boc: string, hash: string } => {
  const data = nekoton.packIntoCell(DATA_STRUCTURE, {
    walletId: WALLET_ID,
    lastCleaned: 0,
    publicKey: publicKey.toFixed(0),
    queries: false,
  }).boc;
  return nekoton.mergeTvc(HIGHLOAD_WALLET_V2_CODE, data);
};

const MESSAGES_STRUCTURE: nt.AbiParam[] = [
  {
    name: 'messages',
    type: 'map(uint16,tuple)',
    components: [
      { name: 'flags', type: 'uint8' },
      { name: 'message', type: 'cell' },
    ],
  },
];

const UNSIGNED_TRANSFER_STRUCTURE: nt.AbiParam[] = [
  { name: 'walletId', type: 'uint32' },
  { name: 'expireAt', type: 'uint32' },
  { name: 'messagesHash', type: 'uint32' },
  ...MESSAGES_STRUCTURE,
];

const SIGNED_TRANSFER_STRUCTURE: nt.AbiParam[] = [
  { name: 'signatureHigh', type: 'uint256' },
  { name: 'signatureLow', type: 'uint256' },
  ...UNSIGNED_TRANSFER_STRUCTURE,
];

const DATA_STRUCTURE: nt.AbiParam[] = [
  { name: 'walletId', type: 'uint32' },
  { name: 'lastCleaned', type: 'uint64' },
  { name: 'publicKey', type: 'uint256' },
  { name: 'queries', type: 'bool' },
];

const HIGHLOAD_WALLET_V2_CODE =
  'te6ccgEBCQEA5QABFP8A9KQT9LzyyAsBAgEgBAIB6vKDCNcYINMf0z/4I6ofUyC58mPtRNDTH9M/0//0BNFTYIBA9A5voTHyYFFzuvKiB/kBVBCH+RDyowL0BNH4AH+OFiGAEPR4b6UgmALTB9QwAfsAkTLiAbPmW4MlochANIBA9EOK5jHIEssfE8s/y//0AMntVAMANCCAQPSWb6UyURCUMFMDud4gkzM2AZIyMOKzAgFICAUCASAHBgBBvl+XaiaGmPmOmf6f+Y+gJoqRBAIHoHN9CYyS2/yV3R8UABe9nOdqJoaa+Y64X/wABNAw';

const WALLET_ID = 0;
