import type * as nt from 'nekoton-wasm';
import core from '../core';

const { nekoton } = core;

/**
 * @category Keystore
 */
export interface Keystore {
  /**
   * Returns signer for given id
   * @param id: unique signer name
   */
  getSigner(id: string): Promise<Signer | undefined>;
}

/**
 * @category Keystore
 */
export interface Signer {
  /**
   * Hex encoded public key
   */
  readonly publicKey: string;

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

  constructor(entries: { [id: string]: nt.Ed25519KeyPair } = {}) {
    for (const [id, signer] of Object.entries(entries)) {
      this.addKeyPair(id, signer);
    }
  }

  public static generateKeyPair(): nt.Ed25519KeyPair {
    return nekoton.ed25519_generateKeyPair();
  }

  public addKeyPair(id: string, keyPair: nt.Ed25519KeyPair) {
    this.signers.set(id, new SimpleSigner(keyPair));
  }

  public removeKeyPair(publicKey: string) {
    this.signers.delete(publicKey);
  }

  public async withNewKey(f: (publicKey: string) => Promise<boolean | undefined>): Promise<string> {
    const newKey = SimpleKeystore.generateKeyPair();
    const publicKey = newKey.publicKey;

    this.addKeyPair(publicKey, newKey);
    return f(publicKey)
      .then(retain => {
        if (retain === false) {
          this.removeKeyPair(publicKey);
        }
        return publicKey;
      })
      .catch((e: any) => {
        this.removeKeyPair(publicKey);
        throw e;
      });
  }

  public async getSigner(publicKey: string): Promise<Signer | undefined> {
    return this.signers.get(publicKey);
  }
}

class SimpleSigner implements Signer {
  constructor(private readonly keyPair: nt.Ed25519KeyPair) {
  }

  readonly publicKey: string = this.keyPair.secretKey;

  async sign(rawData: string): Promise<string> {
    return nekoton.ed25519_sign(this.keyPair.secretKey, rawData);
  }
}
