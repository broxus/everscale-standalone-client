import type * as nt from 'nekoton-wasm';

/**
 * @category Client
 */
export class Clock {
  private impl?: nt.ClockWithOffset;

  private currentOffset: number = 0;

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
    if (this.impl != null) {
      this.impl.updateOffset(this.currentOffset);
    }
  }

  /**
   * Returns current time in milliseconds
   */
  public get time(): number {
    return new Date().getTime() + this.offset;
  }
}
