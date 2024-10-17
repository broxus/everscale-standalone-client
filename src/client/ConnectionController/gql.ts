import type * as nt from 'nekoton-wasm';

import core from '../../core';

/**
 * @category Client
 */
export type GqlSocketParams = {
  /**
   * Path to graphql api endpoints, e.g. `https://mainnet.evercloud.dev/123123/graphql`
   */
  endpoints: string[];
  /**
   * Gql node type
   *
   * @defaultValue `false`
   */
  local?: boolean;
  /**
   * Frequency of sync latency detection
   *
   * @defaultValue `60000`
   */
  latencyDetectionInterval?: number;
  /**
   * Maximum value for the endpoint's blockchain data sync latency
   */
  maxLatency?: number;
};

export class GqlSocket {
  public async connect(params: GqlSocketParams): Promise<nt.GqlConnection> {
    class GqlSender implements nt.IGqlSender {
      private readonly local: boolean;
      private readonly maxLatency: number;
      private readonly latencyDetectionInterval: number;
      private readonly endpoints: Endpoint[];
      private nextLatencyDetectionTime = 0;
      private currentEndpoint?: Endpoint;
      private resolutionPromise?: Promise<Endpoint>;

      constructor(params: GqlSocketParams) {
        this.local = params.local === true;
        this.maxLatency = params.maxLatency || 60000;
        this.latencyDetectionInterval = params.latencyDetectionInterval || 60000;
        this.endpoints = params.endpoints.map(GqlSocket.expandAddress);
        if (this.endpoints.length == 1) {
          this.currentEndpoint = this.endpoints[0];
          this.nextLatencyDetectionTime = Number.MAX_VALUE;
        }
      }

      isLocal(): boolean {
        return this.local;
      }

      send(data: string, handler: nt.StringQuery, _longQuery: boolean) {
        (async () => {
          const now = Date.now();
          try {
            let endpoint: Endpoint;
            if (this.currentEndpoint != null && now < this.nextLatencyDetectionTime) {
              // Default route
              endpoint = this.currentEndpoint;
            } else if (this.resolutionPromise != null) {
              // Already resolving
              endpoint = await this.resolutionPromise;
              delete this.resolutionPromise;
            } else {
              delete this.currentEndpoint;
              // Start resolving (current endpoint is null, or it is time to refresh)
              this.resolutionPromise = this._selectQueryingEndpoint().then(endpoint => {
                this.currentEndpoint = endpoint;
                this.nextLatencyDetectionTime = Date.now() + this.latencyDetectionInterval;
                return endpoint;
              });
              endpoint = await this.resolutionPromise;
              delete this.resolutionPromise;
            }

            const response = await fetch(endpoint.url, {
              method: 'post',
              headers: DEFAULT_HEADERS,
              body: data,
              agent: endpoint.agent,
            } as RequestInit).then(response => response.text());
            handler.onReceive(response);
          } catch (e: any) {
            handler.onError(e);
          }
        })();
      }

      private async _selectQueryingEndpoint(): Promise<Endpoint> {
        const maxLatency = this.maxLatency;
        const endpointCount = this.endpoints.length;

        for (let retryCount = 0; retryCount < 5; ++retryCount) {
          let handlers: { resolve: (endpoint: Endpoint) => void; reject: () => void };
          const promise = new Promise<Endpoint>((resolve, reject) => {
            handlers = {
              resolve: (endpoint: Endpoint) => resolve(endpoint),
              reject: () => reject(undefined),
            };
          });

          let checkedEndpoints = 0;
          let lastLatency: { endpoint: Endpoint; latency: number | undefined } | undefined;

          for (const endpoint of this.endpoints) {
            GqlSocket.checkLatency(endpoint).then(latency => {
              ++checkedEndpoints;

              if (latency !== undefined && latency <= maxLatency) {
                return handlers.resolve(endpoint);
              }

              if (
                lastLatency === undefined ||
                lastLatency.latency === undefined ||
                (latency !== undefined && latency < lastLatency.latency)
              ) {
                lastLatency = { endpoint, latency };
              }

              if (checkedEndpoints >= endpointCount) {
                if (lastLatency?.latency !== undefined) {
                  handlers.resolve(lastLatency.endpoint);
                } else {
                  handlers.reject();
                }
              }
            });
          }

          try {
            return await promise;
          } catch (e: any) {
            let resolveDelay: () => void;
            const delayPromise = new Promise<void>(resolve => {
              resolveDelay = () => resolve();
            });
            setTimeout(() => resolveDelay(), Math.min(100 * retryCount, 5000));
            await delayPromise;
          }
        }

        throw new Error('Not available endpoint found');
      }
    }

    return new core.nekoton.GqlConnection(new GqlSender(params));
  }

  static async checkLatency(endpoint: Endpoint): Promise<number | undefined> {
    const response = (await fetch(`${endpoint.url}?query=%7Binfo%7Bversion%20time%20latency%7D%7D`, {
      method: 'get',
      agent: endpoint.agent,
    } as RequestInit)
      .then(response => response.json())
      .catch((e: any) => {
        core.debugLog(e);
        return undefined;
      })) as any;

    if (typeof response !== 'object' || response == null) {
      return;
    }

    const data = response['data'];
    if (typeof data !== 'object' || data == null) {
      return;
    }

    const info = data['info'];
    if (typeof info !== 'object' || info == null) {
      return;
    }

    const latency = info['latency'];
    if (typeof latency !== 'number') {
      return;
    }
    return latency;
  }

  static expandAddress = (baseUrl: string): Endpoint => {
    const lastBackslashIndex = baseUrl.lastIndexOf('/');
    baseUrl = lastBackslashIndex < 0 ? baseUrl : baseUrl.substring(0, lastBackslashIndex);

    let url: string;
    if (baseUrl.startsWith('http://') || baseUrl.startsWith('https://')) {
      url = `${baseUrl}/graphql`;
    } else if (['localhost', '127.0.0.1'].indexOf(baseUrl) >= 0) {
      url = `http://${baseUrl}/graphql`;
    } else {
      url = `https://${baseUrl}/graphql`;
    }

    return {
      url,
      agent: core.fetchAgent(url),
    };
  };
}

type Endpoint = {
  url: string;
  agent?: any;
};

const DEFAULT_HEADERS = {
  'Content-Type': 'application/json',
};
