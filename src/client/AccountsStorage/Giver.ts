import type * as nt from 'nekoton-wasm';
import { Address } from 'everscale-inpage-provider';

import { Account, PrepareMessageParams, AccountsStorageContext } from './';

/**
 * @category AccountsStorage
 */
export type GiverVersion = 2 | 3;

/**
 * Any account which supports Giver ABI (GiverV2, GiverV3):
 *
 * ```
 * {
 *   "ABI version": 2,
 *   "header": ["pubkey", "time", "expire"],
 *   "functions": [{
 *     "name": "sendTransaction",
 *     "inputs": [
 *       {"name":"dest","type":"address"},
 *       {"name":"value","type":"uint128"},
 *       {"name":"bounce","type":"bool"},
 *     ],
 *     "outputs": []
 *   }],
 *   "events": []
 * }
 * ```
 *
 * @category AccountsStorage
 */
export class GiverAccount implements Account {
  public readonly address: Address;
  private readonly publicKey: string;

  public static readonly GIVER_KEY_PAIR: nt.Ed25519KeyPair = {
    secretKey: '172af540e43a524763dd53b26a066d472a97c4de37d5498170564510608250c3',
    publicKey: '2ada2e65ab8eeab09490e3521415f45b6e42df9c760a639bcf53957550b25a16',
  };

  public static fromVersion(version: GiverVersion): GiverAccount {
    let address: string;
    switch (version) {
      case 2:
        address = '0:ece57bcc6c530283becbbd8a3b24d3c5987cdddc3c8b7b33be6e4a6312490415';
        break;
      case 3:
        address = '0:78fbd6980c10cf41401b32e9b51810415e7578b52403af80dae68ddf99714498';
        break;
      default:
        throw new Error('Unknown version');
    }

    return new GiverAccount({
      address,
      publicKey: GiverAccount.GIVER_KEY_PAIR.publicKey,
    });
  }

  constructor(args: { address: string | Address; publicKey: string }) {
    this.address = args.address instanceof Address ? args.address : new Address(args.address);
    this.publicKey = args.publicKey;
  }

  public async fetchPublicKey(_ctx: AccountsStorageContext): Promise<string> {
    return this.publicKey;
  }

  async prepareMessage(args: PrepareMessageParams, ctx: AccountsStorageContext): Promise<nt.SignedMessage> {
    if (args.payload != null) {
      console.warn('Giver contract does not support payload');
    }

    const signer = await ctx.getSigner(this.publicKey);
    return await ctx.createExternalMessage({
      address: this.address,
      signer,
      timeout: args.timeout,
      abi: GIVER_ABI,
      method: 'sendTransaction',
      params: {
        dest: args.recipient,
        value: args.amount,
        bounce: args.bounce,
      },
    });
  }
}

const GIVER_ABI = `{
  "ABI version": 2,
  "header": ["time", "expire"],
  "functions": [{
    "name": "sendTransaction",
    "inputs": [
      {"name":"dest","type":"address"},
      {"name":"value","type":"uint128"},
      {"name":"bounce","type":"bool"}
    ],
    "outputs": []
  }],
  "events": []
}`;
