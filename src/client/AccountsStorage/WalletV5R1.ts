import type * as nt from 'nekoton-wasm';
import { Address } from 'everscale-inpage-provider';
import { BigNumber } from 'bignumber.js';

import core from '../../core';
import { Account, PrepareMessageParams, AccountsStorageContext } from './';

/**
 * @category AccountsStorage
 */
export class WalletV5R1Account implements Account {
  public readonly address: Address;
  private publicKey?: BigNumber;
  private nonce?: number;
  private isDeployed?: boolean;

  public static async computeAddress(args: {
    publicKey: string | BigNumber;
    workchain?: number;
    nonce?: number;
  }): Promise<Address> {
    await core.ensureNekotonLoaded();

    const publicKey = args.publicKey instanceof BigNumber ? args.publicKey : new BigNumber(`0x${args.publicKey}`);
    const hash = makeStateInit(publicKey, args.nonce).hash;

    return new Address(`${args.workchain != null ? args.workchain : 0}:${hash}`);
  }

  public static async fromPubkey(args: {
    publicKey: string;
    workchain?: number;
    nonce?: number;
  }): Promise<WalletV5R1Account> {
    const publicKey = new BigNumber(`0x${args.publicKey}`);
    const address = await WalletV5R1Account.computeAddress({ publicKey, workchain: args.workchain, nonce: args.nonce });

    const result = new WalletV5R1Account(address);
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
      publicKey = this.publicKey = await this.fetchState(ctx).then(s => new BigNumber(s.publicKey));
    }

    return publicKey.toString(16).padStart(64, '0');
  }

  async prepareMessage(args: PrepareMessageParams, ctx: AccountsStorageContext): Promise<nt.SignedMessage> {
    const { publicKey, seqno, stateInit } = await this.fetchState(ctx);

    const signer = await ctx.getSigner(publicKey);

    const body = args.payload ? ctx.encodeInternalInput(args.payload) : '';
    const validUntil = ctx.nowSec + args.timeout;

    const actions = ctx.packIntoCell({
      structure: ACTIONS,
      abiVersion: '2.3',
      data: {
        prefix: PREFIX.SEND_MESSAGE,
        mode: 3,
        nextAction: '',
        currAction: ctx.encodeInternalMessage({
          dst: args.recipient,
          bounce: args.bounce,
          stateInit: args.stateInit,
          body,
          amount: args.amount,
        }),
      },
    }).boc;

    const params: nt.TokensObject = {
      op: PREFIX.SIGNED_EXTERNAL,
      walletId: this.nonce || 0,
      validUntil,
      seqno,
      actions,
      extended: null,
    };

    const signature = core.nekoton.extendSignature(
      await signer.sign(core.nekoton.packIntoCell(DATA_TO_SIGN, params, '2.3').hash, args.signatureContext),
    );

    const data: nt.TokensObject = {
      walletId: this.nonce || 0,
      validUntil,
      seqno,
      actions,
      extended: null,
      signatureHigh: signature.signatureParts.high,
      signatureLow: signature.signatureParts.low,
    };

    return ctx.createRawExternalMessage({
      address: this.address,
      expireAt: validUntil,
      body: ctx.encodeInternalInput({ abi: WALLET_V5R1_ABI, method: 'sendTransaction', params: data }),
      stateInit,
    });
  }

  private async fetchState(
    ctx: AccountsStorageContext,
  ): Promise<{ publicKey: string; seqno: number; stateInit?: string }> {
    // seqno changes after each message
    const state = await ctx.getFullContractState(this.address);

    this.isDeployed = !!state?.isDeployed;
    let seqno = 0;
    let stateInit;

    if (!!state && this.isDeployed) {
      const data = core.nekoton.extractContractData(state.boc);

      if (!data) {
        throw new Error('Contract is deployed but its data is missing');
      }

      const parsedData = core.nekoton.unpackFromCell(DATA_STRUCTURE, data, false, '2.3');

      this.publicKey = new BigNumber(parsedData.publicKey as string);
      seqno = parsedData.seqno as number;
    } else {
      stateInit = makeStateInit(this.publicKey!, this.nonce).boc;
    }

    return {
      publicKey: this.publicKey!.toString(16).padStart(64, '0'),
      stateInit,
      seqno,
    };
  }
}

const makeStateInit = (publicKey: BigNumber, nonce?: number): { boc: string; hash: string } => {
  const tokens: nt.TokensObject = {
    isSignatureAllowed: true,
    seqno: 0,
    walletId: nonce || 0,
    publicKey: publicKey.toFixed(0),
    extensions: null,
  };

  const data = core.nekoton.packIntoCell(DATA_STRUCTURE, tokens).boc;

  return core.nekoton.mergeTvc(WALLET_V5R1_CODE, data);
};

const DATA_STRUCTURE: nt.AbiParam[] = [
  { name: 'isSignatureAllowed', type: 'bool' }, // allow signed external/internal messages
  { name: 'seqno', type: 'uint32' }, // internal counter. starts from 0
  { name: 'walletId', type: 'uint32' }, // nonce to deploy few wallets for the same public key
  { name: 'publicKey', type: 'uint256' },
  { name: 'extensions', type: 'optional(cell)' },
];

const DATA_TO_SIGN: nt.AbiParam[] = [
  { name: 'op', type: 'uint32' },
  { name: 'walletId', type: 'uint32' },
  { name: 'validUntil', type: 'uint32' },
  { name: 'seqno', type: 'uint32' },
  { name: 'actions', type: 'optional(cell)' },
  { name: 'extended', type: 'optional(cell)' },
];

const ACTIONS: nt.AbiParam[] = [
  { name: 'prefix', type: 'uint32' },
  { name: 'mode', type: 'uint8' },
  { name: 'nextAction', type: 'cell' },
  { name: 'currAction', type: 'cell' },
];

const PREFIX = {
  SIGNED_EXTERNAL: 0x7369676e,
  SEND_MESSAGE: 0x0ec3c86d,
};

const WALLET_V5R1_CODE =
  'te6cckECFAEAAoEAART/APSkE/S88sgLAQIBIAINAgFIAwQC3NAg10nBIJFbj2Mg1wsfIIIQZXh0br0hghBzaW50vbCSXwPgghBleHRuuo60gCDXIQHQdNch+kAw+kT4KPpEMFi9kVvg7UTQgQFB1yH0BYMH9A5voTGRMOGAQNchcH/bPOAxINdJgQKAuZEw4HDiEA8CASAFDAIBIAYJAgFuBwgAGa3OdqJoQCDrkOuF/8AAGa8d9qJoQBDrkOuFj8ACAUgKCwAXsyX7UTQcdch1wsfgABGyYvtRNDXCgCAAGb5fD2omhAgKDrkPoCwBAvIOAR4g1wsfghBzaWduuvLgin8PAeaO8O2i7fshgwjXIgKDCNcjIIAg1yHTH9Mf0x/tRNDSANMfINMf0//XCgAK+QFAzPkQmiiUXwrbMeHywIffArNQB7Dy0IRRJbry4IVQNrry4Ib4I7vy0IgikvgA3gGkf8jKAMsfAc8Wye1UIJL4D95w2zzYEAP27aLt+wL0BCFukmwhjkwCIdc5MHCUIccAs44tAdcoIHYeQ2wg10nACPLgkyDXSsAC8uCTINcdBscSwgBSMLDy0InXTNc5MAGk6GwShAe78uCT10rAAPLgk+1V4tIAAcAAkVvg69csCBQgkXCWAdcsCBwS4lIQseMPINdKERITAJYB+kAB+kT4KPpEMFi68uCR7UTQgQFB1xj0BQSdf8jKAEAEgwf0U/Lgi44UA4MH9Fvy4Iwi1woAIW4Bs7Dy0JDiyFADzxYS9ADJ7VQAcjDXLAgkji0h8uCS0gDtRNDSAFETuvLQj1RQMJExnAGBAUDXIdcKAPLgjuLIygBYzxbJ7VST8sCN4gAQk1vbMeHXTNC01sNe';

const WALLET_V5R1_ABI = `{
  "ABI version": 2,
  "version": "2.3",
  "functions": [{
    "name": "sendTransaction",
    "id": "0x7369676E",
    "inputs": [
      {"name":"walletId","type":"uint32"},
      {"name":"validUntil","type":"uint32"},
      {"name":"seqno","type":"uint32"},
      {"name":"actions","type":"optional(cell)"},
      {"name":"extended","type":"optional(cell)"},
      {"name":"signatureHigh","type":"uint256"},
      {"name":"signatureLow","type":"uint256"}
    ],
    "outputs": []
  }],
  "events": []
}`;
