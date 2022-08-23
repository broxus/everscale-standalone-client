import type * as nt from 'nekoton-wasm';

import { Account, PrepareMessageParams, PrepareMessageContext } from './';

/**
 * @category AccountsStorage
 */
export class GiverAccount implements Account {
  public readonly address: string;
  private publicKey?: string;

  constructor(args: { address: string, publicKey?: string }) {
    this.address = args.address;
    this.publicKey = args.publicKey;
  }

  async prepareMessage(args: PrepareMessageParams, ctx: PrepareMessageContext): Promise<nt.SignedMessage> {
    const publicKey = await this.fetchPublicKey(ctx);
    const signer = await ctx.keystore.getSigner(publicKey);
    if (signer == null) {
      throw new Error('Signer not found');
    }

    const payload = args.payload
      ? ctx.nekoton.encodeInternalInput(args.payload.abi, args.payload.method, args.payload.params)
      : '';

    const unsignedMessage = ctx.nekoton.createExternalMessage(
      ctx.clock,
      this.address,
      GIVER_ABI,
      'sendTransaction',
      undefined,
      {
        dest: args.recipient,
        value: args.amount,
        bounce: args.bounce,
        flags: 3,
        payload,
      },
      publicKey,
      args.timeout,
    );

    try {
      const signature = await signer.sign(unsignedMessage.hash);
      return unsignedMessage.sign(signature);
    } finally {
      unsignedMessage.free();
    }
  }

  private async fetchPublicKey(ctx: PrepareMessageContext): Promise<string> {
    if (this.publicKey != null) {
      return this.publicKey;
    }

    this.publicKey = await ctx.connectionController.use(async ({ data: { transport } }) => {
      const state = await transport.getFullContractState(this.address);
      if (state == null || !state.isDeployed) {
        throw new Error('Contract not deployed');
      }
      return ctx.nekoton.extractPublicKey(state.boc);
    });
    return this.publicKey;
  }
}

const GIVER_ABI = `{
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
