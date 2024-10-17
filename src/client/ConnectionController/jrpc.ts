import type * as nt from 'nekoton-wasm';

import core from '../../core';

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
};

export class JrpcSocket {
  public async connect(params: JrpcSocketParams): Promise<nt.JrpcConnection> {
    class JrpcSender implements nt.IJrpcSender {
      private readonly endpoint: string;
      private readonly endpointAgent?: any;
      private readonly alternativeEndpoint: string;
      private readonly alternativeEndpointAgent: any;

      constructor(params: JrpcSocketParams) {
        this.endpoint = params.endpoint;
        this.endpointAgent = core.fetchAgent(this.endpoint);
        this.alternativeEndpoint = params.alternativeEndpoint != null ? params.alternativeEndpoint : params.endpoint;
        this.alternativeEndpointAgent = core.fetchAgent(this.alternativeEndpoint);
      }

      send(data: string, handler: nt.StringQuery, requiresDb: boolean) {
        (async () => {
          try {
            const url = requiresDb ? this.endpoint : this.alternativeEndpoint;
            const agent = requiresDb ? this.endpointAgent : this.alternativeEndpointAgent;

            const response = await fetch(url, {
              method: 'post',
              headers: DEFAULT_HEADERS,
              body: data,
              agent,
            } as RequestInit).then(response => response.text());
            handler.onReceive(response);
          } catch (e: any) {
            handler.onError(e);
          }
        })();
      }
    }

    return new core.nekoton.JrpcConnection(new JrpcSender(params));
  }
}

const DEFAULT_HEADERS = {
  'Content-Type': 'application/json',
};
