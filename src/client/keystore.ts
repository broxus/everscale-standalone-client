import type * as nt from 'nekoton-wasm';
import core from '../core';

const { nekoton } = core;

/**
 * @category Keystore
 */
export interface Keystore {
  /**
   * Returns signer for given public key
   * @param publicKey - hex or base64 encoded public key
   */
  getSigner(publicKey: string): Promise<Signer | undefined>;
}

/**
 * @category Keystore
 */
export interface Signer {
  /**
   * Sign data as is and return a signature
   * @param rawData - hex or base64 encoded data
   */
  sign(rawData: string): Promise<string>;
}

/**
 * @category Keystore
 */
export class SimpleKeystore implements Keystore {
  private readonly signers: Map<string, Signer> = new Map();

  constructor(keys: nt.Ed25519KeyPair[] = []) {
    for (const key of keys) {
      this.addKeyPair(key);
    }
  }

  public static generateKeyPair(): nt.Ed25519KeyPair {
    return nekoton.ed25519_generateKeyPair();
  }

  public addKeyPair({ publicKey, secretKey }: nt.Ed25519KeyPair) {
    this.signers.set(publicKey, new SimpleSigner(secretKey));
  }

  public removeKeyPair(publicKey: string) {
    this.signers.delete(publicKey);
  }

  public async getSigner(publicKey: string): Promise<Signer | undefined> {
    return this.signers.get(publicKey);
  }
}

class SimpleSigner implements Signer {
  constructor(private readonly privateKey: string) {
  }

  async sign(rawData: string): Promise<string> {
    return nekoton.ed25519_sign(this.privateKey, rawData);
  }
}
