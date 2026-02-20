import type * as nt from 'nekoton-wasm';
import core from '../core';
import type { SignatureContext } from 'everscale-inpage-provider';

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
  sign(rawData: string, signatureContext?: SignatureContext): Promise<string>;
}

/**
 * @category Keystore
 */
export class SimpleKeystore implements Keystore {
  private readonly signers: Map<string, Signer> = new Map();
  private readonly signersByPublicKey: Map<string, Signer> = new Map();

  constructor(entries: { [id: string]: nt.Ed25519KeyPair } = {}) {
    for (const [id, signer] of Object.entries(entries)) {
      this.addKeyPair(id, signer);
    }
  }

  public static generateKeyPair(): nt.Ed25519KeyPair {
    return core.nekoton.ed25519_generateKeyPair();
  }

  public addKeyPair(keyPair: nt.Ed25519KeyPair): void;
  public addKeyPair(id: string, keyPair: nt.Ed25519KeyPair): void;
  public addKeyPair(idOrKeypair: string | nt.Ed25519KeyPair, rest?: nt.Ed25519KeyPair) {
    let id: string;
    let keyPair: nt.Ed25519KeyPair;
    if (typeof idOrKeypair == 'string') {
      id = idOrKeypair;
      keyPair = rest!;
    } else {
      id = idOrKeypair.publicKey;
      keyPair = idOrKeypair;
    }

    const signer = new SimpleSigner(keyPair);
    this.signers.set(id, signer);
    this.signersByPublicKey.set(keyPair.publicKey, signer);
  }

  public removeKeyPair(id: string) {
    const signer = this.signers.get(id);
    if (signer != null) {
      this.signers.delete(id);
      this.signersByPublicKey.delete(signer.publicKey);
    }
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
      keyId?: string;
      /**
       * Default: false
       */
      keepOnError?: boolean;
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

  public async getSigner(id: string): Promise<Signer | undefined> {
    return this.signers.get(id) || this.signersByPublicKey.get(id);
  }
}

class SimpleSigner implements Signer {
  constructor(private readonly keyPair: nt.Ed25519KeyPair) {}

  readonly publicKey: string = this.keyPair.publicKey;

  async sign(rawData: string, signatureContext?: SignatureContext): Promise<string> {
    return core.nekoton.ed25519_sign(this.keyPair.secretKey, rawData, signatureContext || { type: 'empty' });
  }
}
