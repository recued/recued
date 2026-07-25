/** D-196 S3b — sealed, single-use customer claim credentials.
 *
 * The customer-facing claim secret is a short-lived capability, never the
 * long-lived MCP/LLM bearer itself. The bearer is sealed under a key derived
 * from the claim secret; SQLite stores only the secret's SHA-256 digest and
 * AES-256-GCM ciphertext. A database copy therefore cannot recover a customer
 * bearer without the separately delivered claim URL.
 *
 * Redemption is an atomic compare-and-set on `consumed_at`. Wrong, expired,
 * revoked, replayed, or tampered claims fail closed and never return payload
 * bytes. Issuing a replacement revokes every older unconsumed claim for that
 * customer in the same transaction. */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import type Database from 'better-sqlite3';
import { MCP_INBOUND_TOKEN_PREFIX } from '@recued/contracts';

export const SELLER_CUSTOMER_CLAIMS_TABLE = 'seller_customer_claims';
export const SELLER_CLAIM_SECRET_PREFIX = 'recued_claim_';
export const SELLER_CLAIM_DEFAULT_TTL_MS = 60 * 60 * 1000;
export const SELLER_CLAIM_MAX_TTL_MS = 24 * 60 * 60 * 1000;

const CLAIM_SECRET_BYTES = 32;
const CLAIM_SECRET_BASE64URL_LENGTH = 43;
const CLAIM_KEY_BYTES = 32;
const CLAIM_IV_BYTES = 12;
const CLAIM_TAG_BYTES = 16;
const CLAIM_KDF_INFO = 'recued/v1/seller/customer_claim_payload';
const CLAIM_AAD_PREFIX = 'recued/v1/seller/customer_claim';
const MCP_BEARER_BASE64URL_LENGTH = 43;
const MODEL_ALIAS_MAX = 120;
const URL_MAX = 2_048;
const BEARER_MAX = 512;
const PAYLOAD_KEYS = [
  'bearer_plaintext',
  'mcp_url',
  'llm_gateway_base_url',
  'llm_gateway_model_alias',
] as const;

export interface SellerClaimPayload {
  readonly bearer_plaintext: string;
  readonly mcp_url: string | null;
  readonly llm_gateway_base_url: string | null;
  readonly llm_gateway_model_alias: string | null;
}

export interface SellerClaimIssueInput {
  readonly customer_id: string;
  readonly contract_id: string;
  readonly payload: SellerClaimPayload;
  readonly now: number;
  readonly ttl_ms?: number;
}

export interface SellerIssuedClaim {
  readonly claim_id: string;
  readonly claim_secret: string;
  readonly expires_at: number;
}

export type SellerClaimConsumeResult =
  | { readonly status: 'claimed'; readonly payload: SellerClaimPayload }
  | {
      readonly status:
        | 'not_found'
        | 'expired'
        | 'already_claimed'
        | 'revoked'
        | 'corrupt';
    };

export interface SellerClaimStore {
  issue(input: SellerClaimIssueInput): SellerIssuedClaim;
  consume(claim_secret: string, now: number): SellerClaimConsumeResult;
  revokeCustomerClaims(customer_id: string, now: number): number;
  purge(before: number): number;
}

export class SellerClaimStoreValidationError extends Error {
  constructor(detail: string) {
    super(`seller_claim_invalid: ${detail}`);
    this.name = 'SellerClaimStoreValidationError';
  }
}

interface ClaimRow {
  claim_id: string;
  claim_secret_hash: string;
  customer_id: string;
  contract_id: string;
  payload_ciphertext: string;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
  revoked_at: number | null;
}

export const ensureSellerClaimSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${SELLER_CUSTOMER_CLAIMS_TABLE} (
      claim_id           TEXT PRIMARY KEY,
      claim_secret_hash  TEXT NOT NULL UNIQUE,
      customer_id        TEXT NOT NULL,
      contract_id        TEXT NOT NULL,
      payload_ciphertext TEXT NOT NULL,
      created_at         INTEGER NOT NULL,
      expires_at         INTEGER NOT NULL CHECK (expires_at > created_at),
      consumed_at        INTEGER,
      revoked_at         INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_seller_customer_claims_active_customer
      ON ${SELLER_CUSTOMER_CLAIMS_TABLE} (customer_id)
      WHERE consumed_at IS NULL AND revoked_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_seller_customer_claims_expiry
      ON ${SELLER_CUSTOMER_CLAIMS_TABLE} (expires_at);
  `);
};

const cleanId = (value: string, field: string): string => {
  if (typeof value !== 'string') {
    throw new SellerClaimStoreValidationError(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new SellerClaimStoreValidationError(`${field} must be non-empty`);
  }
  if (trimmed.length > 256) {
    throw new SellerClaimStoreValidationError(`${field} is too long`);
  }
  return trimmed;
};

const isHttpsUrl = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > URL_MAX) {
    return false;
  }
  if (!/^https:\/\/\S+$/i.test(value) || /[\\\u0000-\u001f\u007f]/u.test(value)) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:'
      && parsed.hostname.length > 0
      && parsed.username.length === 0
      && parsed.password.length === 0
      && parsed.search.length === 0
      && parsed.hash.length === 0;
  } catch {
    return false;
  }
};

const validatePayload = (value: SellerClaimPayload): SellerClaimPayload => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SellerClaimStoreValidationError('payload must be an object');
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new SellerClaimStoreValidationError('payload must be a plain object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set<string>(PAYLOAD_KEYS);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new SellerClaimStoreValidationError(`payload.${String(key)} is not allowed`);
    }
  }
  const raw = Object.create(null) as Record<string, unknown>;
  for (const key of PAYLOAD_KEYS) {
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw new SellerClaimStoreValidationError(
        `payload.${key} must be an own enumerable data property`,
      );
    }
    raw[key] = descriptor.value;
  }

  const bearer = raw.bearer_plaintext;
  if (
    typeof bearer !== 'string'
    || !bearer.startsWith(MCP_INBOUND_TOKEN_PREFIX)
    || bearer.length !== MCP_INBOUND_TOKEN_PREFIX.length + MCP_BEARER_BASE64URL_LENGTH
    || bearer.length > BEARER_MAX
    || !/^[A-Za-z0-9_-]+$/u.test(bearer.slice(MCP_INBOUND_TOKEN_PREFIX.length))
  ) {
    throw new SellerClaimStoreValidationError('payload.bearer_plaintext is invalid');
  }
  const mcpUrl = raw.mcp_url;
  if (mcpUrl !== null && !isHttpsUrl(mcpUrl)) {
    throw new SellerClaimStoreValidationError('payload.mcp_url must be null or HTTPS');
  }
  const llmUrl = raw.llm_gateway_base_url;
  if (llmUrl !== null && !isHttpsUrl(llmUrl)) {
    throw new SellerClaimStoreValidationError(
      'payload.llm_gateway_base_url must be null or HTTPS',
    );
  }
  if (mcpUrl === null && llmUrl === null) {
    throw new SellerClaimStoreValidationError('payload must expose at least one door endpoint');
  }
  const rawAlias = raw.llm_gateway_model_alias;
  if (
    rawAlias !== null
    && (
      typeof rawAlias !== 'string'
      || rawAlias.trim().length === 0
      || rawAlias.trim().length > MODEL_ALIAS_MAX
    )
  ) {
    throw new SellerClaimStoreValidationError(
      'payload.llm_gateway_model_alias must be null or a non-empty bounded string',
    );
  }
  const alias = typeof rawAlias === 'string' ? rawAlias.trim() : null;
  if (llmUrl === null && alias !== null) {
    throw new SellerClaimStoreValidationError(
      'payload.llm_gateway_model_alias requires llm_gateway_base_url',
    );
  }

  return {
    bearer_plaintext: bearer,
    mcp_url: mcpUrl as string | null,
    llm_gateway_base_url: llmUrl as string | null,
    llm_gateway_model_alias: alias as string | null,
  };
};

export const isSellerClaimSecret = (value: unknown): value is string =>
  typeof value === 'string'
  && new RegExp(
    `^${SELLER_CLAIM_SECRET_PREFIX}[A-Za-z0-9_-]{${CLAIM_SECRET_BASE64URL_LENGTH}}$`,
  ).test(value);

export const generateSellerClaimSecret = (): string =>
  `${SELLER_CLAIM_SECRET_PREFIX}${randomBytes(CLAIM_SECRET_BYTES).toString('base64url')}`;

const hashClaimSecret = (claimSecret: string): string =>
  createHash('sha256').update(claimSecret, 'utf8').digest('hex');

const claimKey = (claimSecret: string, claimId: string): Buffer =>
  Buffer.from(hkdfSync(
    'sha256',
    Buffer.from(claimSecret, 'utf8'),
    Buffer.from(claimId, 'utf8'),
    Buffer.from(CLAIM_KDF_INFO, 'utf8'),
    CLAIM_KEY_BYTES,
  ));

const claimAad = (input: {
  claim_id: string;
  customer_id: string;
  contract_id: string;
  expires_at: number;
}): Buffer => Buffer.from(JSON.stringify([
  CLAIM_AAD_PREFIX,
  input.claim_id,
  input.customer_id,
  input.contract_id,
  input.expires_at,
]), 'utf8');

const sealPayload = (input: {
  claim_secret: string;
  claim_id: string;
  customer_id: string;
  contract_id: string;
  expires_at: number;
  payload: SellerClaimPayload;
  iv: Buffer;
}): string => {
  if (input.iv.length !== CLAIM_IV_BYTES) {
    throw new SellerClaimStoreValidationError(
      `claim IV must be ${CLAIM_IV_BYTES} bytes`,
    );
  }
  const cipher = createCipheriv(
    'aes-256-gcm',
    claimKey(input.claim_secret, input.claim_id),
    input.iv,
  );
  cipher.setAAD(claimAad(input));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(input.payload), 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([input.iv, ciphertext, cipher.getAuthTag()]).toString('base64');
};

const openPayload = (row: ClaimRow, claimSecret: string): SellerClaimPayload => {
  const framed = Buffer.from(row.payload_ciphertext, 'base64');
  if (framed.length < CLAIM_IV_BYTES + CLAIM_TAG_BYTES) {
    throw new Error('claim ciphertext is truncated');
  }
  const iv = framed.subarray(0, CLAIM_IV_BYTES);
  const tag = framed.subarray(framed.length - CLAIM_TAG_BYTES);
  const ciphertext = framed.subarray(CLAIM_IV_BYTES, framed.length - CLAIM_TAG_BYTES);
  const decipher = createDecipheriv(
    'aes-256-gcm',
    claimKey(claimSecret, row.claim_id),
    iv,
  );
  decipher.setAAD(claimAad(row));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return validatePayload(JSON.parse(plaintext.toString('utf8')) as SellerClaimPayload);
};

export interface SellerClaimStoreOptions {
  readonly newClaimId?: () => string;
  readonly newClaimSecret?: () => string;
  readonly newIv?: () => Buffer;
}

export const createSellerClaimStore = (
  db: Database.Database,
  options: SellerClaimStoreOptions = {},
): SellerClaimStore => {
  ensureSellerClaimSchema(db);
  const newClaimId = options.newClaimId ?? (() => `seller_claim_${randomUUID()}`);
  const newClaimSecret = options.newClaimSecret ?? generateSellerClaimSecret;
  const newIv = options.newIv ?? (() => randomBytes(CLAIM_IV_BYTES));

  const revokeActiveForCustomer = db.prepare(`
    UPDATE ${SELLER_CUSTOMER_CLAIMS_TABLE}
       SET revoked_at = @now
     WHERE customer_id = @customer_id
       AND consumed_at IS NULL
       AND revoked_at IS NULL
  `);
  const insert = db.prepare(`
    INSERT INTO ${SELLER_CUSTOMER_CLAIMS_TABLE} (
      claim_id, claim_secret_hash, customer_id, contract_id,
      payload_ciphertext, created_at, expires_at, consumed_at, revoked_at
    ) VALUES (
      @claim_id, @claim_secret_hash, @customer_id, @contract_id,
      @payload_ciphertext, @created_at, @expires_at, NULL, NULL
    )
  `);
  const findByHash = db.prepare(`
    SELECT claim_id, claim_secret_hash, customer_id, contract_id,
           payload_ciphertext, created_at, expires_at, consumed_at, revoked_at
      FROM ${SELLER_CUSTOMER_CLAIMS_TABLE}
     WHERE claim_secret_hash = ?
  `);
  const consume = db.prepare(`
    UPDATE ${SELLER_CUSTOMER_CLAIMS_TABLE}
       SET consumed_at = @now
     WHERE claim_id = @claim_id
       AND consumed_at IS NULL
       AND revoked_at IS NULL
       AND expires_at > @now
  `);
  const revokeCorrupt = db.prepare(`
    UPDATE ${SELLER_CUSTOMER_CLAIMS_TABLE}
       SET revoked_at = @now
     WHERE claim_id = @claim_id
       AND consumed_at IS NULL
       AND revoked_at IS NULL
  `);
  const purge = db.prepare(`
    DELETE FROM ${SELLER_CUSTOMER_CLAIMS_TABLE}
     WHERE expires_at <= @before
        OR (consumed_at IS NOT NULL AND consumed_at <= @before)
        OR (revoked_at IS NOT NULL AND revoked_at <= @before)
  `);

  const issueTransaction = db.transaction((input: SellerClaimIssueInput): SellerIssuedClaim => {
    const customer_id = cleanId(input.customer_id, 'customer_id');
    const contract_id = cleanId(input.contract_id, 'contract_id');
    if (!Number.isSafeInteger(input.now) || input.now < 0) {
      throw new SellerClaimStoreValidationError('now must be a non-negative safe integer');
    }
    const ttl = input.ttl_ms ?? SELLER_CLAIM_DEFAULT_TTL_MS;
    if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > SELLER_CLAIM_MAX_TTL_MS) {
      throw new SellerClaimStoreValidationError(
        `ttl_ms must be between 1 and ${SELLER_CLAIM_MAX_TTL_MS}`,
      );
    }
    const expires_at = input.now + ttl;
    if (!Number.isSafeInteger(expires_at)) {
      throw new SellerClaimStoreValidationError('claim expiry is outside the safe range');
    }
    const claim_id = cleanId(newClaimId(), 'generated claim_id');
    const claim_secret = newClaimSecret();
    if (!isSellerClaimSecret(claim_secret)) {
      throw new SellerClaimStoreValidationError('generated claim_secret has invalid shape');
    }
    const payload = validatePayload(input.payload);
    const payload_ciphertext = sealPayload({
      claim_secret,
      claim_id,
      customer_id,
      contract_id,
      expires_at,
      payload,
      iv: newIv(),
    });

    revokeActiveForCustomer.run({ customer_id, now: input.now });
    insert.run({
      claim_id,
      claim_secret_hash: hashClaimSecret(claim_secret),
      customer_id,
      contract_id,
      payload_ciphertext,
      created_at: input.now,
      expires_at,
    });
    return { claim_id, claim_secret, expires_at };
  });

  const consumeTransaction = db.transaction((
    claimSecret: string,
    now: number,
  ): SellerClaimConsumeResult => {
    if (!isSellerClaimSecret(claimSecret)) return { status: 'not_found' };
    if (!Number.isSafeInteger(now) || now < 0) return { status: 'not_found' };
    const row = findByHash.get(hashClaimSecret(claimSecret)) as ClaimRow | undefined;
    if (!row) return { status: 'not_found' };
    if (row.revoked_at !== null) return { status: 'revoked' };
    if (row.consumed_at !== null) return { status: 'already_claimed' };
    if (row.expires_at <= now) return { status: 'expired' };

    let payload: SellerClaimPayload;
    try {
      payload = openPayload(row, claimSecret);
    } catch {
      revokeCorrupt.run({ claim_id: row.claim_id, now });
      return { status: 'corrupt' };
    }
    const updated = consume.run({ claim_id: row.claim_id, now });
    if (updated.changes !== 1) return { status: 'already_claimed' };
    return { status: 'claimed', payload };
  });

  return {
    issue: (input) => issueTransaction(input),
    consume: (claimSecret, now) => consumeTransaction(claimSecret, now),
    revokeCustomerClaims(customer_id, now) {
      const cleanCustomerId = cleanId(customer_id, 'customer_id');
      if (!Number.isSafeInteger(now) || now < 0) {
        throw new SellerClaimStoreValidationError('now must be a non-negative safe integer');
      }
      return revokeActiveForCustomer.run({ customer_id: cleanCustomerId, now }).changes;
    },
    purge(before) {
      if (!Number.isSafeInteger(before) || before < 0) {
        throw new SellerClaimStoreValidationError('before must be a non-negative safe integer');
      }
      return purge.run({ before }).changes;
    },
  };
};
