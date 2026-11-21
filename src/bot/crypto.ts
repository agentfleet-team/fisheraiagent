import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// A guild's Gemini key is AES-256-GCM encrypted under a key derived from the
// BOT_ENCRYPTION_KEY environment variable. The plaintext never touches disk.

export interface KeyRecord {
  iv: string;
  tag: string;
  data: string;
}

export function deriveEncryptionKey(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

export function encryptSecret(plaintext: string, key: Buffer): KeyRecord {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

export function decryptSecret(record: KeyRecord, key: Buffer): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(record.data, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
