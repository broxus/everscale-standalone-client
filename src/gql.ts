import * as nt from 'nekoton-wasm';

/**
 * @category Client
 */
export type GqlSocketParams = {
  endpoint: string;
  timeout: number;
  local: boolean;
}

export class GqlSocket {
  public async connect(clock: nt.ClockWithOffset, params: GqlSocketParams): Promise<nt.GqlTransport> {
    return new nt.GqlTransport(clock, new GqlSender(params));
  }
}

class GqlSender implements nt.IGqlSender {
  constructor(private readonly params: GqlSocketParams) {
  }

  isLocal(): boolean {
    return this.params.local;
  }

  send(data: string, handler: nt.GqlQuery) {
    (async () => {
      try {
        const response = await fetch(this.params.endpoint, {
          method: 'post',
          headers: {
            'Content-Type': 'application/json',
          },
          body: data,
        }).then((response) => response.text());
        handler.onReceive(response);
      } catch (e) {
        handler.onError(e);
      }
    })();
  }
}
