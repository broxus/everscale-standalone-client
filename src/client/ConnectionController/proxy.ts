import * as nt from 'nekoton-wasm';

export abstract class ConnectionFactory {
  abstract create(clock: nt.ClockWithOffset): nt.ProxyConnection;
}
/**
 * @category Client
 */
export type ProxyParams = {
  connectionFactory: ConnectionFactory;
};
