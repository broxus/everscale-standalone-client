import type * as nt from 'nekoton-wasm';

import core from '../../core';

const { nekoton, fetch } = core;

/**
 * @category Client
 */
export type JrpcSocketParams = {
  // Path to jrpc api endpoint
  endpoint: string
}

export class JrpcSocket {
  public async connect(
    clock: nt.ClockWithOffset,
    params: JrpcSocketParams,
  ): Promise<nt.JrpcConnection> {
    class JrpcSender {
      private readonly params: JrpcSocketParams;

      constructor(params: JrpcSocketParams) {
        this.params = params;
      }

      send(data: string, handler: nt.JrpcQuery) {
        ;(async () => {
          try {
            const response = await fetch(this.params.endpoint, {
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
