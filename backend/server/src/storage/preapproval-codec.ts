/** Use the existing encrypted-collection envelope. Crypto completes outside
 * SQLite transactions; the repository rechecks the immutable ciphertext and
 * key availability before committing any authority change. */
import { encrypt, decrypt, type EncryptedEntry } from '@recued/storage';
import { RpcError } from '@recued/contracts';
import { createCipheriv, randomBytes } from 'node:crypto';

export interface PreapprovalCodec {
  seal(value: unknown): Promise<string>;
  /** Bounded ingress snapshots must be durable before the synchronous event
   * bus queues them. Uses the same AES-GCM envelope as seal/open. */
  sealSync(value: unknown): string;
  open(value: string): Promise<unknown>;
  assertUnlocked(): void;
}

export const createPreapprovalCodec = (
  getKeyBytes: () => Uint8Array | null,
): PreapprovalCodec => {
  const bytes = (): Uint8Array => {
    const key = getKeyBytes();
    if (key === null || key.byteLength !== 32) {
      throw new RpcError('server_locked', 'Unlock Recued before using pre-approval.', 423);
    }
    return key;
  };
  const key = () => crypto.subtle.importKey('raw', new Uint8Array(bytes()),
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return {
    assertUnlocked: () => { bytes(); },
    sealSync(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', bytes(), iv);
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final(), cipher.getAuthTag()]);
      const now = Date.now(); bytes();
      return JSON.stringify({ ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), created_at: now, updated_at: now });
    },
    seal: async value => {
      const entry = await encrypt(await key(), JSON.stringify(value));
      bytes();
      return JSON.stringify(entry);
    },
    open: async value => {
      const parsed: unknown = JSON.parse(value);
      if (parsed === null || typeof parsed !== 'object') throw new Error('Invalid pre-approval ciphertext.');
      const entry = parsed as Partial<EncryptedEntry>;
      if (typeof entry.ciphertext !== 'string' || typeof entry.iv !== 'string'
        || typeof entry.created_at !== 'number' || typeof entry.updated_at !== 'number') {
        throw new Error('Invalid pre-approval ciphertext.');
      }
      const json = await decrypt(await key(), { ciphertext: entry.ciphertext, iv: entry.iv,
        created_at: entry.created_at, updated_at: entry.updated_at });
      bytes();
      return JSON.parse(json) as unknown;
    },
  };
};
