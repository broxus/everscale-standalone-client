import type * as nt from 'nekoton-wasm';

import core from '../../core';

const { nekoton, fetch } = core;

/**
 * @category Client
 */
export type JrpcSocketParams = {
  /**
   * Full JRPC API endpoint
   */
  endpoint: string;
  /**
   * Alternative JRPC API that will be used for broadcasting messages or fetching states
   */
  alternativeEndpoint?: string;
}

export class JrpcSocket {
  public async connect(
    clock: nt.ClockWithOffset,
    params: JrpcSocketParams,
  ): Promise<nt.JrpcConnection> {
    class JrpcSender {
      private readonly endpoint: string;
      private readonly alternativeEndpoint: string;

      constructor(params: JrpcSocketParams) {
        this.endpoint = params.endpoint;
        this.alternativeEndpoint = params.alternativeEndpoint != null
          ? params.alternativeEndpoint
          : params.endpoint;
      }

      send(data: string, handler: nt.JrpcQuery, requiresDb: boolean) {
        ;(async () => {
          try {
            const response = await fetch(requiresDb ? this.endpoint : this.alternativeEndpoint, {
              method: 'post',
              headers: {
                'Content-Type': 'application/json',
              },
              body: data,
            }).then((response) => response.text());
            handler.onReceive(response);
          } catch (e: any) {
            handler.onError(e);
          }
        })();
      }
    }

    return new nekoton.JrpcConnection(clock, new JrpcSender(params));
  }
}
