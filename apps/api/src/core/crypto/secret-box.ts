import 'server-only';
// Encryption at rest for provider credentials (docs/communications-c2.md §7.2).
//
// AES-256-GCM with a random 96-bit IV and a 128-bit tag. Each value is bound to its place by
// associated data (for example business id + connection id + field), so a ciphertext copied into
// another row or another business does not decrypt. Envelope: v1.<keyId>.<iv>.<ciphertext+tag>,
// base64url. The first configured key encrypts; every configured key decrypts (rotation).
// Plaintext and keys are never logged and never put into error messages.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface SecretKey { readonly id: string; readonly key: Buffer }

export class SecretBoxError extends Error {
  constructor(readonly reason: 'not_configured' | 'unknown_key' | 'malformed' | 'undecryptable') {
    super(`secret box: ${reason}`);
    this.name = 'SecretBoxError';
  }
}

const ENVELOPE = /^v1\.([a-z0-9][a-z0-9_-]{0,31})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{22,})$/;
const TAG_BYTES = 16;

export interface SecretBox {
  /** Id of the key new values are encrypted with. */
  readonly activeKeyId: string;
  seal(plaintext: string, aad: string): string;
  open(envelope: string, aad: string): string;
  /** Key id an envelope was sealed with, or undefined if it is not an envelope. */
  keyIdOf(envelope: string): string | undefined;
}

export function createSecretBox(keys: readonly SecretKey[]): SecretBox {
  if (keys.length === 0) throw new SecretBoxError('not_configured');
  for (const k of keys) if (k.key.length !== 32) throw new SecretBoxError('malformed');
  const active = keys[0]!;
  const byId = new Map(keys.map((k) => [k.id, k.key]));
  return {
    activeKeyId: active.id,
    seal(plaintext, aad) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', active.key, iv);
      cipher.setAAD(Buffer.from(aad, 'utf8'));
      const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
      return `v1.${active.id}.${iv.toString('base64url')}.${body.toString('base64url')}`;
    },
    open(envelope, aad) {
      const match = ENVELOPE.exec(envelope);
      if (!match) throw new SecretBoxError('malformed');
      const key = byId.get(match[1]!);
      if (!key) throw new SecretBoxError('unknown_key');
      const iv = Buffer.from(match[2]!, 'base64url');
      const body = Buffer.from(match[3]!, 'base64url');
      if (iv.length !== 12 || body.length < TAG_BYTES) throw new SecretBoxError('malformed');
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAAD(Buffer.from(aad, 'utf8'));
        decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
        return Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_BYTES)), decipher.final()]).toString('utf8');
      } catch {
        throw new SecretBoxError('undecryptable');
      }
    },
    keyIdOf(envelope) {
      return ENVELOPE.exec(envelope)?.[1];
    },
  };
}
