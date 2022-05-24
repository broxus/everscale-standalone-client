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

  /**
   * Generate and add a new key
   *
   * @returns keyId of the new signer
   */
  public async withNewKey(
    f: (publicKey: string) => Promise<boolean | undefined>,
    options: {
      /**
       * Default: public key of the new key pair
       */
      keyId?: string,
      /**
       * Default: false
       */
      keepOnError?: boolean
    } = {},
  ): Promise<string> {
    const newKey = SimpleKeystore.generateKeyPair();
    const keyId = options.keyId != null ? options.keyId : newKey.publicKey;
    const keepOnError = options.keepOnError || false;

    this.addKeyPair(keyId, newKey);
    return f(keyId)
      .then(retain => {
        if (retain === false) {
          this.removeKeyPair(keyId);
        }
        return keyId;
      })
      .catch((e: any) => {
        if (!keepOnError) {
          this.removeKeyPair(keyId);
        }
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
