import type * as nt from 'nekoton-wasm';

import core from '../core';

const { nekoton, fetch } = core;

/**
 * @category Client
 */
export type GqlSocketParams = {
  // Path to graphql api endpoints, e.g. `https://main.ton.dev`
  endpoints: string[]
  // Frequency of sync latency detection
  latencyDetectionInterval: number
  // Maximum value for the endpoint's blockchain data sync latency
  maxLatency: number
  // Gql node type
  local: boolean
}

export class GqlSocket {
  public async connect(
    clock: nt.ClockWithOffset,
    params: GqlSocketParams,
  ): Promise<nt.GqlTransport> {
    class GqlSender implements nt.IGqlSender {
      private readonly params: GqlSocketParams;
      private readonly endpoints: string[];
      private nextLatencyDetectionTime: number = 0;
      private currentEndpoint?: string;
      private resolutionPromise?: Promise<string>;

      constructor(params: GqlSocketParams) {
        this.params = params;
        this.endpoints = params.endpoints.map(GqlSocket.expandAddress);
        if (this.endpoints.length == 1) {
          this.currentEndpoint = this.endpoints[0];
          this.nextLatencyDetectionTime = Number.MAX_VALUE;
        }
      }

      isLocal(): boolean {
        return this.params.local;
      }

      send(data: string, handler: nt.GqlQuery) {
        ;(async () => {
          const now = Date.now();
          try {
            let endpoint: string;
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
              this.resolutionPromise = this._selectQueryingEndpoint().then(
                (endpoint) => {
                  this.currentEndpoint = endpoint;
                  this.nextLatencyDetectionTime =
                    Date.now() + this.params.latencyDetectionInterval;
                  return endpoint;
                },
              );
              endpoint = await this.resolutionPromise;
              delete this.resolutionPromise;
            }

            const response = await fetch(endpoint, {
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

      private async _selectQueryingEndpoint(): Promise<string> {
        const maxLatency = this.params.maxLatency || 60000;
        let endpointCount = this.endpoints.length;

        for (let retryCount = 0; retryCount < 5; ++retryCount) {
          let handlers: { resolve: (endpoint: string) => void; reject: () => void };
          const promise = new Promise<string>((resolve, reject) => {
            handlers = {
              resolve: (endpoint: string) => resolve(endpoint),
              reject: () => reject(undefined),
            };
          });

          let checkedEndpoints = 0;
          let lastLatency: { endpoint: string; latency: number | undefined } | undefined;

          for (const endpoint of this.endpoints) {
            GqlSocket.checkLatency(endpoint).then((latency) => {
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
            const delayPromise = new Promise<void>((resolve) => {
              resolveDelay = () => resolve();
            });
            setTimeout(() => resolveDelay(), Math.min(100 * retryCount, 5000));
            await delayPromise;
          }
        }

        throw new Error('Not available endpoint found');
      }
    }

    return new nekoton.GqlTransport(clock, new GqlSender(params));
  }

  static async checkLatency(endpoint: string): Promise<number | undefined> {
    let response = await fetch(`${endpoint}?query=%7Binfo%7Bversion%20time%20latency%7D%7D`, {
      method: 'get',
    })
      .then((response) => response.json())
      .catch((e: any) => {
        console.error(e);
        return undefined;
      }) as any;

    if (typeof response !== 'object' || response == null) {
      return;
    }

    let data = response['data'];
    if (typeof data !== 'object' || response == null) {
      return;
    }

    let info = data['info'];
    if (typeof info !== 'object' || response == null) {
      return;
    }

    let latency = info['latency'];
    if (typeof latency !== 'number') {
      return;
    }
    return latency;
  }

  static expandAddress = (baseUrl: string): string => {
    const lastBackslashIndex = baseUrl.lastIndexOf('/');
    baseUrl = lastBackslashIndex < 0 ? baseUrl : baseUrl.substring(0, lastBackslashIndex);

    if (baseUrl.startsWith('http://') || baseUrl.startsWith('https://')) {
      return `${baseUrl}/graphql`;
    } else if (['localhost', '127.0.0.1'].indexOf(baseUrl) >= 0) {
      return `http://${baseUrl}/graphql`;
    } else {
      return `https://${baseUrl}/graphql`;
    }
  };
}
