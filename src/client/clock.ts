import type * as nt from 'nekoton-wasm';

/**
 * Wrapper around clocks which are used in `EverscaleStandaloneClient` instances
 *
 * @category Client
 */
export class Clock {
  private impls: nt.ClockWithOffset[] = [];

  private currentOffset = 0;

  constructor(offset?: number) {
    if (offset != null) {
      this.currentOffset = offset;
    }
  }

  /**
   * Clock offset in milliseconds
   */
  public get offset(): number {
    return this.currentOffset;
  }

  /**
   * Set clock offset in milliseconds
   */
  public set offset(value: number) {
    this.currentOffset = value;
    for (const impl of this.impls) {
      impl.updateOffset(this.currentOffset);
    }
  }

  /**
   * Returns current time in milliseconds
   */
  public get time(): number {
    return new Date().getTime() + this.offset;
  }

  /**
   * Detaches all affected providers
   *
   * NOTE: affected providers offset remains the same
   */
  public detach() {
    this.impls = [];
  }
}
