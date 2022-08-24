import type * as nt from 'nekoton-wasm';
import { Address } from 'everscale-inpage-provider';
import BigNumber from 'bignumber.js';

import core from '../../core';
import { Account, PrepareMessageParams, PrepareMessageContext, FetchPublicKeyContext } from './';

const { ensureNekotonLoaded, nekoton } = core;

/**
 * @category AccountsStorage
 */
export class HighloadWalletV2 implements Account {
  public readonly address: Address;
  private publicKey?: BigNumber;

  public static async computeAddress(args: {
    publicKey: string | BigNumber,
    workchain?: number
  }): Promise<Address> {
    // TODO: Somehow propagate init params
    await ensureNekotonLoaded();

    const publicKey = args.publicKey instanceof BigNumber
      ? args.publicKey
      : new BigNumber(`0x${args.publicKey}`);
    const tvc = makeStateInit(publicKey);
    const hash = nekoton.getBocHash(tvc);
    return new Address(`${args.workchain != null ? args.workchain : 0}:${hash}`);
  }

  public static async fromPubkey(args: { publicKey: string, workchain?: number }): Promise<HighloadWalletV2> {
    const publicKey = new BigNumber(`0x${args.publicKey}`);
    const address = await HighloadWalletV2.computeAddress({ publicKey, workchain: args.workchain });
    const result = new HighloadWalletV2(address);
    result.publicKey = publicKey;
    return result;
  }

  constructor(address: string | Address) {
    this.address = address instanceof Address ? address : new Address(address);
  }

  async fetchPublicKey(ctx: FetchPublicKeyContext): Promise<string> {
    let publicKey = this.publicKey;
    if (publicKey == null) {
      publicKey = this.publicKey = await ctx.connectionController.use(async ({ data: { transport } }) => {
        const state = await transport.getFullContractState(this.address.toString());
        if (state == null || !state.isDeployed) {
          throw new Error('Contract not deployed and public key was not specified');
        }
        return new BigNumber(`0x${ctx.nekoton.extractPublicKey(state.boc)}`);
      });
    }
    return publicKey.toString(16).padStart(64, '0');
  }

  async prepareMessage(args: PrepareMessageParams, ctx: PrepareMessageContext): Promise<nt.SignedMessage> {
    const { publicKey, stateInit } = await this.fetchState(ctx);
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
      messages: [[0, {
        flags: 3,
        message: internalMessage,
      }]],
    };

    const messages = ctx.nekoton.packIntoCell(MESSAGES_STRUCTURE, params);
    const messagesHash = ctx.nekoton.getBocHash(messages);

    params.walletId = WALLET_ID;
    params.expireAt = expireAt;
    params.messagesHash = `0x${messagesHash.slice(-8)}`;

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
        return { publicKey: this.publicKey };
      } else if (this.publicKey == null) {
        const data = ctx.nekoton.extractContractData(state.boc);
        if (data == null) {
          throw new Error('Failed to extract contract data');
        }
        return parseInitData(data);
      } else {
        return { publicKey: this.publicKey };
      }
    });

    if (this.publicKey == null) {
      this.publicKey = result.publicKey;
    }

    return {
      publicKey: result.publicKey.toString(16).padStart(64, '0'),
      stateInit,
    };
  }
}

const parseInitData = (cell: string): { publicKey: BigNumber } => {
  const parsed = nekoton.unpackFromCell(DATA_STRUCTURE, cell, true);
  if (typeof parsed !== 'object' || typeof parsed['publicKey'] !== 'string') {
    throw new Error('Invalid contract data');
  }
  return {
    publicKey: new BigNumber(parsed.publicKey),
  };
};

const makeStateInit = (publicKey: BigNumber) => {
  const data = nekoton.packIntoCell(DATA_STRUCTURE, {
    walletId: WALLET_ID,
    lastCleaned: 0,
    publicKey: publicKey.toFixed(0),
    queries: false,
  });
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

const HIGHLOAD_WALLET_V2_CODE = 'te6ccgEBCQEA5QABFP8A9KQT9LzyyAsBAgEgBAIB6vKDCNcYINMf0z/4I6ofUyC58mPtRNDTH9M/0//0BNFTYIBA9A5voTHyYFFzuvKiB/kBVBCH+RDyowL0BNH4AH+OFiGAEPR4b6UgmALTB9QwAfsAkTLiAbPmW4MlochANIBA9EOK5jHIEssfE8s/y//0AMntVAMANCCAQPSWb6UyURCUMFMDud4gkzM2AZIyMOKzAgFICAUCASAHBgBBvl+XaiaGmPmOmf6f+Y+gJoqRBAIHoHN9CYyS2/yV3R8UABe9nOdqJoaa+Y64X/wABNAw';

const WALLET_ID = 0;
