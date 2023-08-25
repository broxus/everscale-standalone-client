import type * as nt from 'nekoton-wasm';

import core from '../../core';

const { nekoton, fetch, fetchAgent } = core;

/**
 * @category Client
 */
export type ProtoSocketParams = {
  /**
   * Full RPC API endpoint
   */
  endpoint: string;
};

export class ProtoSocket {
  public async connect(params: ProtoSocketParams): Promise<nt.ProtoConnection> {
    class ProtoSender implements nt.IProtoSender {
      private readonly endpoint: string;
      private readonly endpointAgent?: any;

      constructor(params: ProtoSocketParams) {
        this.endpoint = params.endpoint;
        this.endpointAgent = fetchAgent(this.endpoint);
      }

      send(data: Uint8Array, handler: nt.BytesQuery, _: boolean) {
        (async () => {
          try {
            const response = await fetch(this.endpoint, {
              method: 'post',
              headers: DEFAULT_HEADERS,
              body: data,
              agent: this.endpointAgent,
            } as RequestInit).then(response => response.arrayBuffer());
            handler.onReceive(new Uint8Array(response));
          } catch (e: any) {
            handler.onError(e);
          }
        })();
      }
    }

    return new nekoton.ProtoConnection(new ProtoSender(params));
  }
}

const DEFAULT_HEADERS = {
  'Content-Type': 'application/x-protobuf',
};
