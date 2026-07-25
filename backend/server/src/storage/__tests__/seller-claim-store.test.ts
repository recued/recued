import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SELLER_CLAIM_DEFAULT_TTL_MS,
  SELLER_CLAIM_MAX_TTL_MS,
  SELLER_CUSTOMER_CLAIMS_TABLE,
  SellerClaimStoreValidationError,
  createSellerClaimStore,
  type SellerClaimPayload,
} from '../seller-claim-store.js';

const NOW = 1_800_000_000_000;
const CLAIM_A = `recued_claim_${'a'.repeat(43)}`;
const CLAIM_B = `recued_claim_${'b'.repeat(43)}`;
const BEARER = `recued_${'z'.repeat(43)}`;

const payload = (overrides: Partial<SellerClaimPayload> = {}): SellerClaimPayload => ({
  bearer_plaintext: BEARER,
  mcp_url: 'https://seller.example/mcp',
  llm_gateway_base_url: 'https://seller.example/v1',
  llm_gateway_model_alias: 'recued-seller',
  ...overrides,
});

describe('D-196 S3b seller claim store', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('stores only a claim hash plus sealed bearer payload, then reveals it once', () => {
    const store = createSellerClaimStore(db, {
      newClaimId: () => 'claim-1',
      newClaimSecret: () => CLAIM_A,
      newIv: () => Buffer.alloc(12, 7),
    });
    const issued = store.issue({
      customer_id: 'customer-1',
      contract_id: 'contract-1',
      payload: payload(),
      now: NOW,
    });
    expect(issued).toEqual({
      claim_id: 'claim-1',
      claim_secret: CLAIM_A,
      expires_at: NOW + SELLER_CLAIM_DEFAULT_TTL_MS,
    });

    const row = db.prepare(`SELECT * FROM ${SELLER_CUSTOMER_CLAIMS_TABLE}`).get() as
      Record<string, unknown>;
    expect(row.claim_secret_hash).not.toBe(CLAIM_A);
    expect(row.payload_ciphertext).not.toContain(BEARER);
    expect(Buffer.from(String(row.payload_ciphertext), 'base64').toString('utf8'))
      .not.toContain(BEARER);

    expect(store.consume(CLAIM_A, NOW + 1)).toEqual({
      status: 'claimed',
      payload: payload(),
    });
    expect(store.consume(CLAIM_A, NOW + 2)).toEqual({ status: 'already_claimed' });
  });

  it('a wrong secret never consumes the matching claim', () => {
    const store = createSellerClaimStore(db, {
      newClaimId: () => 'claim-1',
      newClaimSecret: () => CLAIM_A,
    });
    store.issue({
      customer_id: 'customer-1',
      contract_id: 'contract-1',
      payload: payload(),
      now: NOW,
    });

    expect(store.consume(CLAIM_B, NOW + 1)).toEqual({ status: 'not_found' });
    expect(store.consume('not-a-claim', NOW + 1)).toEqual({ status: 'not_found' });
    expect(store.consume(CLAIM_A, NOW + 1)).toMatchObject({ status: 'claimed' });
  });

  it('rejects expiry at the boundary without exposing payload bytes', () => {
    const store = createSellerClaimStore(db, {
      newClaimId: () => 'claim-1',
      newClaimSecret: () => CLAIM_A,
    });
    store.issue({
      customer_id: 'customer-1',
      contract_id: 'contract-1',
      payload: payload(),
      now: NOW,
      ttl_ms: 500,
    });
    expect(store.consume(CLAIM_A, NOW + 499)).toMatchObject({ status: 'claimed' });

    const other = createSellerClaimStore(db, {
      newClaimId: () => 'claim-2',
      newClaimSecret: () => CLAIM_B,
    });
    other.issue({
      customer_id: 'customer-2',
      contract_id: 'contract-2',
      payload: payload(),
      now: NOW,
      ttl_ms: 500,
    });
    expect(other.consume(CLAIM_B, NOW + 500)).toEqual({ status: 'expired' });
  });

  it('issuing a replacement atomically revokes the older unclaimed credential', () => {
    const secrets = [CLAIM_A, CLAIM_B];
    let id = 0;
    const store = createSellerClaimStore(db, {
      newClaimId: () => `claim-${++id}`,
      newClaimSecret: () => secrets.shift()!,
    });
    store.issue({
      customer_id: 'customer-1',
      contract_id: 'contract-1',
      payload: payload(),
      now: NOW,
    });
    store.issue({
      customer_id: 'customer-1',
      contract_id: 'contract-1',
      payload: payload({ mcp_url: null }),
      now: NOW + 1,
    });

    expect(store.consume(CLAIM_A, NOW + 2)).toEqual({ status: 'revoked' });
    expect(store.consume(CLAIM_B, NOW + 2)).toEqual({
      status: 'claimed',
      payload: payload({ mcp_url: null }),
    });
  });

  it('rolls back prior-claim revocation when replacement insertion fails', () => {
    const ids = ['same-id', 'same-id'];
    const secrets = [CLAIM_A, CLAIM_B];
    const store = createSellerClaimStore(db, {
      newClaimId: () => ids.shift()!,
      newClaimSecret: () => secrets.shift()!,
    });
    store.issue({
      customer_id: 'customer-1',
      contract_id: 'contract-1',
      payload: payload(),
      now: NOW,
    });
    expect(() => store.issue({
      customer_id: 'customer-1',
      contract_id: 'contract-1',
      payload: payload(),
      now: NOW + 1,
    })).toThrow();
    expect(store.consume(CLAIM_A, NOW + 2)).toMatchObject({ status: 'claimed' });
  });

  it('fails closed and revokes a tampered ciphertext row', () => {
    const store = createSellerClaimStore(db, {
      newClaimId: () => 'claim-1',
      newClaimSecret: () => CLAIM_A,
    });
    store.issue({
      customer_id: 'customer-1',
      contract_id: 'contract-1',
      payload: payload(),
      now: NOW,
    });
    db.prepare(`
      UPDATE ${SELLER_CUSTOMER_CLAIMS_TABLE}
         SET payload_ciphertext = 'AAAA'
       WHERE claim_id = 'claim-1'
    `).run();

    expect(store.consume(CLAIM_A, NOW + 1)).toEqual({ status: 'corrupt' });
    expect(store.consume(CLAIM_A, NOW + 2)).toEqual({ status: 'revoked' });
  });

  it('validates endpoint, payload, secret, and TTL authority', () => {
    const store = createSellerClaimStore(db, {
      newClaimId: () => 'claim-1',
      newClaimSecret: () => CLAIM_A,
    });
    const issue = (p: SellerClaimPayload, ttl_ms?: number) => store.issue({
      customer_id: 'customer-1',
      contract_id: 'contract-1',
      payload: p,
      now: NOW,
      ...(ttl_ms !== undefined ? { ttl_ms } : {}),
    });

    expect(() => issue(payload({ mcp_url: 'http://seller.example/mcp' })))
      .toThrow(SellerClaimStoreValidationError);
    expect(() => issue(payload({ mcp_url: 'https://user:secret@seller.example/mcp' })))
      .toThrow(SellerClaimStoreValidationError);
    expect(() => issue(payload({ mcp_url: 'https://seller.example/mcp?token=secret' })))
      .toThrow(SellerClaimStoreValidationError);
    expect(() => issue(payload({ mcp_url: 'https://seller.example/mcp#fragment' })))
      .toThrow(SellerClaimStoreValidationError);
    expect(() => issue(payload({ mcp_url: 'https://seller.example\\attacker' })))
      .toThrow(SellerClaimStoreValidationError);
    expect(() => issue(payload({
      mcp_url: null,
      llm_gateway_base_url: null,
      llm_gateway_model_alias: null,
    }))).toThrow(SellerClaimStoreValidationError);
    expect(() => issue({ ...payload(), form_action: 'post' } as never))
      .toThrow(SellerClaimStoreValidationError);
    const inherited = Object.create(payload()) as SellerClaimPayload;
    expect(() => issue(inherited)).toThrow(SellerClaimStoreValidationError);
    const accessorBacked = payload();
    Object.defineProperty(accessorBacked, 'mcp_url', {
      enumerable: true,
      get: () => 'https://attacker.example/mcp',
    });
    expect(() => issue(accessorBacked)).toThrow(SellerClaimStoreValidationError);
    expect(() => issue(payload({ bearer_plaintext: 'recued_too-short' })))
      .toThrow(SellerClaimStoreValidationError);
    expect(() => issue(payload(), SELLER_CLAIM_MAX_TTL_MS + 1))
      .toThrow(SellerClaimStoreValidationError);

    const badSecretStore = createSellerClaimStore(db, {
      newClaimId: () => 'claim-bad-secret',
      newClaimSecret: () => 'short',
    });
    expect(() => badSecretStore.issue({
      customer_id: 'customer-2',
      contract_id: 'contract-2',
      payload: payload(),
      now: NOW,
    })).toThrow(SellerClaimStoreValidationError);
  });

  it('supports explicit revocation and bounded cleanup', () => {
    const store = createSellerClaimStore(db, {
      newClaimId: () => 'claim-1',
      newClaimSecret: () => CLAIM_A,
    });
    store.issue({
      customer_id: 'customer-1',
      contract_id: 'contract-1',
      payload: payload(),
      now: NOW,
      ttl_ms: 100,
    });
    expect(store.revokeCustomerClaims('customer-1', NOW + 1)).toBe(1);
    expect(store.consume(CLAIM_A, NOW + 2)).toEqual({ status: 'revoked' });
    expect(store.purge(NOW + 99)).toBe(1);
    expect(store.consume(CLAIM_A, NOW + 100)).toEqual({ status: 'not_found' });
  });
});
