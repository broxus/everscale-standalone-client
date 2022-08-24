import type * as nt from 'nekoton-wasm';
import { Address } from 'everscale-inpage-provider';
import BigNumber from 'bignumber.js';

import core from '../../core';
import { Account, PrepareMessageParams, PrepareMessageContext } from './';

const { ensureNekotonLoaded, nekoton } = core;

/**
 * @category AccountsStorage
 */
export class WalletV3Account implements Account {
  public readonly address: Address;
  private publicKey?: BigNumber;

  public static async computeAddress(args: { publicKey: string | BigNumber, workchain?: number }): Promise<Address> {
    // TODO: Somehow propagate init params
    await ensureNekotonLoaded();

    const publicKey = args.publicKey instanceof BigNumber
      ? args.publicKey
      : new BigNumber(`0x${args.publicKey}`);
    const tvc = makeStateInit(publicKey);
    const hash = nekoton.getBocHash(tvc);
    return new Address(`${args.workchain != null ? args.workchain : 0}:${hash}`);
  }

  public static async fromPubkey(args: { publicKey: string, workchain?: number }): Promise<WalletV3Account> {
    const publicKey = new BigNumber(`0x${args.publicKey}`);
    const address = await WalletV3Account.computeAddress({ publicKey, workchain: args.workchain });
    const result = new WalletV3Account(address);
    result.publicKey = publicKey;
    return result;
  }

  constructor(address: Address) {
    this.address = address;
  }

  async prepareMessage(args: PrepareMessageParams, ctx: PrepareMessageContext): Promise<nt.SignedMessage> {
    const { seqno, publicKey, stateInit } = await this.fetchState(ctx);
    const signer = await ctx.keystore.getSigner(publicKey);
    if (signer == null) {
      throw new Error('Signer not found');
    }

    const expireAt = ~~(ctx.clock.nowMs / 1000) + args.timeout;

    const attachedPayload = args.payload
      ? ctx.nekoton.encodeInternalInput(args.payload.abi, args.payload.method, args.payload.params)
      : undefined;

    const internalMessage = ctx.nekoton.encodeInternalMessage(
      undefined,
      args.recipient,
      args.bounce,
      args.stateInit,
      attachedPayload,
      args.amount,
    );

    const params: nt.TokensObject = {
      walletId: WALLET_ID,
      expireAt,
      seqno,
      flags: 3,
      message: internalMessage,
    };

    const unsignedPayload = ctx.nekoton.packIntoCell(
      UNSIGNED_TRANSFER_STRUCTURE,
      params,
    );
    const hash = ctx.nekoton.getBocHash(unsignedPayload);
    const signature = await signer.sign(hash);
    const { signatureParts } = ctx.nekoton.extendSignature(signature);

    params.signatureHigh = signatureParts.high;
    params.signatureLow = signatureParts.low;
    const signedPayload = ctx.nekoton.packIntoCell(
      SIGNED_TRANSFER_STRUCTURE,
      params,
    );

    return ctx.nekoton.createRawExternalMessage(
      this.address.toString(),
      stateInit,
      signedPayload,
      expireAt,
    );
  }

  private async fetchState(ctx: PrepareMessageContext): Promise<{
    seqno: number,
    publicKey: string,
    stateInit?: string,
  }> {
    let stateInit: string | undefined = undefined;
    const result = await ctx.connectionController.use(async ({ data: { transport } }) => {
      const state = await transport.getFullContractState(this.address.toString());
      if (state == null || !state.isDeployed) {
        if (this.publicKey == null) {
          throw new Error('Contract not deployed and public key was not specified');
        }

        stateInit = makeStateInit(this.publicKey);
        return { seqno: 0, publicKey: this.publicKey };
      } else {
        const data = ctx.nekoton.extractContractData(state.boc);
        if (data == null) {
          throw new Error('Failed to extract contract data');
        }
        return parseInitData(data);
      }
    });

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

const parseInitData = (cell: string): { seqno: number, publicKey: BigNumber } => {
  const parsed = nekoton.unpackFromCell(DATA_STRUCTURE, cell, false);
  if (typeof parsed !== 'object' || typeof parsed['seqno'] !== 'string' || typeof parsed['publicKey'] !== 'string') {
    throw new Error('Invalid contract data ');
  }
  return {
    seqno: parseInt(parsed.seqno),
    publicKey: new BigNumber(parsed.publicKey),
  };
};

const makeStateInit = (publicKey: BigNumber) => {
  const data = nekoton.packIntoCell(DATA_STRUCTURE, {
    seqno: 0,
    walletId: WALLET_ID,
    publicKey: publicKey.toFixed(0),
  });
  return nekoton.mergeTvc(WALLET_V3_CODE, data);
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

const WALLET_V3_CODE = 'te6ccgEBAQEAcQAA3v8AIN0gggFMl7ohggEznLqxn3Gw7UTQ0x/THzHXC//jBOCk8mCDCNcYINMf0x/TH/gjE7vyY+1E0NMf0x/T/9FRMrryoVFEuvKiBPkBVBBV+RDyo/gAkyDXSpbTB9QC+wDo0QGkyMsfyx/L/8ntVA==';

const WALLET_ID = 0x4BA92D8A;
