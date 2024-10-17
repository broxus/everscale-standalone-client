import type * as nt from 'nekoton-wasm';
import { Address } from 'everscale-inpage-provider';
import BigNumber from 'bignumber.js';

import core from '../../core';
import { Account, PrepareMessageParams, AccountsStorageContext } from './';

/**
 * @category AccountsStorage
 */
export class WalletV3Account implements Account {
  public readonly address: Address;
  private publicKey?: BigNumber;

  public static async computeAddress(args: { publicKey: string | BigNumber; workchain?: number }): Promise<Address> {
    // TODO: Somehow propagate init params
    await core.ensureNekotonLoaded();

    const publicKey = args.publicKey instanceof BigNumber ? args.publicKey : new BigNumber(`0x${args.publicKey}`);
    const hash = makeStateInit(publicKey).hash;
    return new Address(`${args.workchain != null ? args.workchain : 0}:${hash}`);
  }

  public static async fromPubkey(args: { publicKey: string; workchain?: number }): Promise<WalletV3Account> {
    const publicKey = new BigNumber(`0x${args.publicKey}`);
    const address = await WalletV3Account.computeAddress({ publicKey, workchain: args.workchain });
    const result = new WalletV3Account(address);
    result.publicKey = publicKey;
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
    }
    return publicKey.toString(16).padStart(64, '0');
  }

  async prepareMessage(args: PrepareMessageParams, ctx: AccountsStorageContext): Promise<nt.SignedMessage> {
    const { seqno, publicKey, stateInit } = await this.fetchState(ctx);
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
      walletId: WALLET_ID,
      expireAt,
      seqno,
      flags: 3,
      message: internalMessage,
    };

    const hash = ctx.packIntoCell({ structure: UNSIGNED_TRANSFER_STRUCTURE, data: params }).hash;
    const signature = await signer.sign(hash, args.signatureId);
    const { signatureParts } = ctx.extendSignature(signature);

    params.signatureHigh = signatureParts.high;
    params.signatureLow = signatureParts.low;
    const signedPayload = ctx.packIntoCell({
      structure: SIGNED_TRANSFER_STRUCTURE,
      data: params,
    }).boc;

    return ctx.createRawExternalMessage({
      address: this.address,
      body: signedPayload,
      stateInit,
      expireAt,
    });
  }

  private async fetchState(ctx: AccountsStorageContext): Promise<{
    seqno: number;
    publicKey: string;
    stateInit?: string;
  }> {
    let stateInit: string | undefined = undefined;
    let result: { seqno: number; publicKey: BigNumber };

    const state = await ctx.getFullContractState(this.address);
    if (state == null || !state.isDeployed) {
      if (this.publicKey == null) {
        throw new Error('Contract not deployed and public key was not specified');
      }

      stateInit = makeStateInit(this.publicKey).boc;
      result = { seqno: 0, publicKey: this.publicKey };
    } else {
      const data = ctx.extractContractData(state.boc);
      if (data == null) {
        throw new Error('Failed to extract contract data');
      }
      result = parseInitData(ctx, data);
    }

    if (this.publicKey == null) {
      this.publicKey = result.publicKey;
    } else if (!this.publicKey.eq(result.publicKey)) {
      throw new Error('Public key mismatch');
    }

    return {
      seqno: result.seqno,
      publicKey: result.publicKey.toString(16).padStart(64, '0'),
      stateInit,
    };
  }
}

const parseInitData = (ctx: AccountsStorageContext, boc: string): { seqno: number; publicKey: BigNumber } => {
  const parsed = ctx.unpackFromCell({
    structure: DATA_STRUCTURE,
    boc,
    allowPartial: false,
  });
  if (typeof parsed !== 'object' || typeof parsed['seqno'] !== 'string' || typeof parsed['publicKey'] !== 'string') {
    throw new Error('Invalid contract data ');
  }
  return {
    seqno: parseInt(parsed.seqno),
    publicKey: new BigNumber(parsed.publicKey),
  };
};

const makeStateInit = (publicKey: BigNumber): { boc: string, hash: string } => {
  const data = core.nekoton.packIntoCell(DATA_STRUCTURE, {
    seqno: 0,
    walletId: WALLET_ID,
    publicKey: publicKey.toFixed(0),
  }).boc;
  return core.nekoton.mergeTvc(WALLET_V3_CODE, data);
};

const UNSIGNED_TRANSFER_STRUCTURE: nt.AbiParam[] = [
  { name: 'walletId', type: 'uint32' },
  { name: 'expireAt', type: 'uint32' },
  { name: 'seqno', type: 'uint32' },
  { name: 'flags', type: 'uint8' },
  { name: 'message', type: 'cell' },
];

const SIGNED_TRANSFER_STRUCTURE: nt.AbiParam[] = [
  { name: 'signatureHigh', type: 'uint256' },
  { name: 'signatureLow', type: 'uint256' },
  ...UNSIGNED_TRANSFER_STRUCTURE,
];

const DATA_STRUCTURE: nt.AbiParam[] = [
  { name: 'seqno', type: 'uint32' },
  { name: 'walletId', type: 'uint32' },
  { name: 'publicKey', type: 'uint256' },
];

const WALLET_V3_CODE =
  'te6ccgEBAQEAcQAA3v8AIN0gggFMl7ohggEznLqxn3Gw7UTQ0x/THzHXC//jBOCk8mCDCNcYINMf0x/TH/gjE7vyY+1E0NMf0x/T/9FRMrryoVFEuvKiBPkBVBBV+RDyo/gAkyDXSpbTB9QC+wDo0QGkyMsfyx/L/8ntVA==';

const WALLET_ID = 0x4ba92d8a;
