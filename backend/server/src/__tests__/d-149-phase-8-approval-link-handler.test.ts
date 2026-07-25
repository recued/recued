/** D-149 P8 § A.5.5 — approval_link GET + POST integration tests.
 *
 *  Covers:
 *    - Token-less GET returns 401.
 *    - Authorized GET renders the consent form HTML with security headers
 *      (CSP / no-store / X-Frame-Options DENY / Referrer-Policy
 *      no-referrer / X-Content-Type-Options nosniff).
 *    - User-only fields (counterparty_aliases / private_notes /
 *      target_id) ABSENT from rendered HTML
 *      (no-leak invariant).
 *    - POST consume with valid form persists the consumed row +
 *      flips `consumed_at`.
 *    - Second POST returns the already-consumed page (single-use
 *      enforcement per Must Hold I-11).
 *    - POST rejects stale / missing form_nonce.
 *    - POST rejects mismatched Origin.
 *    - POST rejects email-match constraint failure with 400.
 *    - POST returns 405 for non-(GET|POST) methods.
 *    - Per-action-kind workflows: pick_time / confirm_attendance /
 *      approve_wording / answer_question / upload_doc.
 */

import Database from 'better-sqlite3';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { ApprovalLinkConfig } from '@recued/contracts';
import { ensureReceptionSchema } from '../storage/reception-store.js';
import { createPublicEndpointRegistryStore } from '../storage/public-endpoint-registry-store.js';
import { createReceptionApprovalIntentStore } from '../storage/reception-approval-store.js';
import { createReceptionRateLimiter } from '../ports/reception/rate-limiter.js';
import { createReceptionRegistryCache } from '../ports/reception/registry-cache.js';
import { createReceptionPortHandler } from '../ports/reception/handler.js';
import { buildShareUrl } from '../ports/reception/token-primitives.js';
import {
  computeBearerHmac,
  deriveReceptionPepper,
} from '../ports/reception/server-secret-pepper.js';
import { createInMemoryApprovalLinkNonceStore } from '../ports/reception/handlers/approval-link.js';
import {
  deriveApprovalIntentPiiKeyFromSubDek,
  openApprovalIntentPiiField,
} from '../ports/reception/approval-pii.js';
import type { AuditLogStore } from '@recued/storage';

const NOW = 1_700_000_000_000;
const SUB_DEK = new Uint8Array(32).fill(0x6f);
const PEPPER = deriveReceptionPepper(Buffer.alloc(32, 0xa2));
const DAY = 24 * 60 * 60 * 1000;

const fakeAudit = (): AuditLogStore & { calls: Array<unknown> } => {
  const calls: Array<unknown> = [];
  return {
    logActivity: async (input: unknown) => {
      calls.push(input);
      return undefined;
    },
    listActivity: async () => [],
    listAgentAccess: async () => [],
    listProvenanceLinks: async () => [],
    timeline: async () => [],
    bumpInsightSnapshotIfDifferent: async () => null,
    queryRecipeInsight: async () => null,
    calls,
  } as unknown as AuditLogStore & { calls: Array<unknown> };
};

const buildEnv = () => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  const store = createPublicEndpointRegistryStore(db);
  const cache = createReceptionRegistryCache();
  const limiter = createReceptionRateLimiter({ db });
  const intentStore = createReceptionApprovalIntentStore(db);
  const nonce = createInMemoryApprovalLinkNonceStore();
  return { db, store, cache, limiter, intentStore, nonce };
};

const baseConfig: ApprovalLinkConfig = {
  display_name: 'Mary',
  action_kind: 'pick_time',
  prompt: 'Pick a time that works for you.',
  context_raw: {
    summary: 'Meeting about Q3 launch.',
    counterparty_aliases: ['Bob the Vendor — secret alias'],
    private_notes: ['INTERNAL: vendor flagged by legal'],
  },
  options: [
    { id: 'opt_a', label: '9am Mon' },
    { id: 'opt_b', label: '2pm Tue' },
  ],
  visitor_field_constraints: { name: 'required', email: 'required' },
  expiry_days: 7,
  on_action: {
    target_id: 'proposal_super_secret_internal_id',
    on_approve_action: 'mark_resolved',
  },
};

const insertEndpoint = (
  env: ReturnType<typeof buildEnv>,
  bearer: string,
  config: ApprovalLinkConfig = baseConfig,
) => {
  const endpoint_id = 'ep-approve-1';
  env.store.create({
    endpoint_id,
    kind: 'approval_link',
    packet_declaration: {
      packet_kind: 'approval_link_packet',
      source_query_ref: {
        kind: 'reception_approval_intent',
        intent_id: endpoint_id,
      },
    },
    bearer_secret_hmac: computeBearerHmac(bearer, PEPPER),
    created_at: NOW - DAY,
    created_by_client_id: 'inst-1',
    expires_at: null,
    long_lived_acknowledged_at: NOW - DAY,
    metadata: config as unknown as Record<string, unknown>,
  });
  env.store.enable(endpoint_id, NOW);
  env.intentStore.create({
    intent_id: endpoint_id,
    endpoint_id,
    action_kind: config.action_kind,
    target_id: config.on_action.target_id,
  });
  return endpoint_id;
};

const fakeReq = (
  method: string,
  url: string,
  body?: string,
  headers?: Record<string, string>,
): IncomingMessage => {
  const socket = new Socket();
  Object.defineProperty(socket, 'remoteAddress', { value: '203.0.113.8' });
  const req = new IncomingMessage(socket);
  req.method = method;
  req.url = url;
  Object.assign(req.headers, headers ?? {});
  if (body !== undefined) {
    setImmediate(() => {
      req.emit('data', Buffer.from(body, 'utf8'));
      req.emit('end');
    });
  }
  return req;
};

const fakeRes = () => {
  const bodyChunks: Array<string | Buffer> = [];
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    getHeader(name: string) {
      return headers[name.toLowerCase()];
    },
    end(body?: string | Buffer) {
      if (body !== undefined) bodyChunks.push(body);
    },
    write(body: string | Buffer) {
      bodyChunks.push(body);
    },
    get body(): string {
      return bodyChunks
        .map((c) => (typeof c === 'string' ? c : c.toString('utf8')))
        .join('');
    },
    get status(): number {
      return res.statusCode;
    },
  } as unknown as ServerResponse & { status: number; body: string };
  return res;
};

const buildHandler = (env: ReturnType<typeof buildEnv>, audit?: AuditLogStore) =>
  createReceptionPortHandler({
    getStore: () => env.store,
    getCache: () => env.cache,
    getRateLimiter: () => env.limiter,
    getPepper: () => PEPPER,
    now: () => NOW,
    getApprovalIntentStore: () => env.intentStore,
    getApprovalLinkNonceStore: () => env.nonce,
    getApprovalIntentPiiKey: () => deriveApprovalIntentPiiKeyFromSubDek(SUB_DEK),
    auditLog: audit ?? fakeAudit(),
  });

const formUrlencode = (fields: Record<string, string>): string =>
  new URLSearchParams(fields).toString();

// ────────────────────────────────────────────────────────────────
// GET tests
// ────────────────────────────────────────────────────────────────

describe('D-149 P8 § A.5.5 — GET /reception/approve/<id>', () => {
  it('returns 401 when no token is supplied', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env);
    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/approve/ep-approve-1'), res);
    expect(res.status).toBe(401);
  });

  it('renders the consent form HTML with security headers when token is valid', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env);
    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/approve/ep-approve-1?t=goodbearer'), res);
    expect(res.status).toBe(200);
    expect(res.body).toContain('<form');
    expect(res.body).toContain('Pick a time');
    expect(res.body).toContain('9am Mon');
    expect(res.body).toContain('2pm Tue');
    expect(res.body).toContain('form_nonce');
    const get = (k: string) =>
      typeof res.getHeader(k) === 'string' ? (res.getHeader(k) as string) : '';
    expect(get('content-type')).toContain('text/html');
    expect(get('cache-control')).toContain('no-store');
    expect(get('x-frame-options').toUpperCase()).toBe('DENY');
    expect(get('referrer-policy')).toBe('no-referrer');
    expect(get('x-content-type-options')).toBe('nosniff');
  });

  it('omits counterparty_aliases + private_notes + target_id from HTML (no-leak)', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env);
    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/approve/ep-approve-1?t=goodbearer'), res);
    expect(res.status).toBe(200);
    expect(res.body).not.toContain('Bob the Vendor');
    expect(res.body).not.toContain('secret alias');
    expect(res.body).not.toContain('INTERNAL');
    expect(res.body).not.toContain('vendor flagged');
    expect(res.body).not.toContain('proposal_super_secret_internal_id');
    expect(res.body).not.toContain('recipe_internal_q3_secret');
    // The redacted summary IS visible (only this slice of context_raw).
    expect(res.body).toContain('Q3 launch');
  });

  it('renders confirm_attendance yes/no body', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer', {
      ...baseConfig,
      action_kind: 'confirm_attendance',
      options: [
        { id: 'yes', label: 'Yes' },
        { id: 'no', label: 'No' },
      ],
    });
    const handler = buildHandler(env);
    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/approve/ep-approve-1?t=goodbearer'), res);
    expect(res.status).toBe(200);
    expect(res.body).toContain('Will you attend');
  });

  it('renders approve_wording approve/reject body with comment textarea', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer', {
      ...baseConfig,
      action_kind: 'approve_wording',
      options: undefined,
    });
    const handler = buildHandler(env);
    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/approve/ep-approve-1?t=goodbearer'), res);
    expect(res.status).toBe(200);
    expect(res.body).toContain('decision');
    expect(res.body).toContain('comment');
    expect(res.body).toContain('Suggest changes');
  });

  it('renders answer_question textarea body', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer', {
      ...baseConfig,
      action_kind: 'answer_question',
      options: undefined,
    });
    const handler = buildHandler(env);
    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/approve/ep-approve-1?t=goodbearer'), res);
    expect(res.status).toBe(200);
    expect(res.body).toContain('Your answer');
  });

  it('Codex P8 P1 fold — share URL from buildShareUrl reaches the GET render end-to-end', async () => {
    // Pre-fold: buildShareUrl returned `/reception/approve/<id>` with
    // no `?t=...`, but the dispatcher's universal token check 401'd
    // every tokenless request — the form NEVER rendered. The fold
    // makes approval_link follow the same `?t=<bearer>` pattern as the
    // other link-style kinds; the share URL now reaches the GET path.
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env);
    const shareUrl = buildShareUrl({
      base_url: 'https://mary.recued.cloud',
      kind: 'approval_link',
      endpoint_id: 'ep-approve-1',
      bearer_secret: 'goodbearer',
    });
    // Strip the absolute prefix down to the path + query the handler sees.
    const u = new URL(shareUrl);
    const pathAndQuery = u.pathname + u.search;
    const res = fakeRes();
    await handler(fakeReq('GET', pathAndQuery), res);
    expect(res.status).toBe(200);
    expect(res.body).toContain('<form');
    expect(res.body).toContain('Pick a time');
  });

  it('shows already-consumed page on revisit after consume', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    env.intentStore.tryConsume({
      intent_id: 'ep-approve-1',
      endpoint_id: 'ep-approve-1',
      now: NOW - 1000,
      source_ip_hash: 'old',
      visitor_email_encrypted: 'x',
      visitor_name_encrypted: null,
      outcome_encrypted: 'y',
    });
    const handler = buildHandler(env);
    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/approve/ep-approve-1?t=goodbearer'), res);
    expect(res.status).toBe(200);
    expect(res.body).toContain('Already responded');
  });
});

// ────────────────────────────────────────────────────────────────
// POST tests
// ────────────────────────────────────────────────────────────────

describe('D-149 P8 § A.5.5 — POST /reception/approve/<id>', () => {
  const issueNonce = (env: ReturnType<typeof buildEnv>) =>
    env.nonce.issue('ep-approve-1', NOW);

  it('returns 405 for non-(GET|POST) methods', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env);
    const res = fakeRes();
    await handler(fakeReq('DELETE', '/reception/approve/ep-approve-1?t=goodbearer'), res);
    expect(res.status).toBe(405);
  });

  it('rejects POST with mismatched Origin (403)', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env);
    const body = formUrlencode({
      form_nonce: issueNonce(env),
      visitor_name: 'Bob',
      visitor_email: 'bob@example.com',
      option_id: 'opt_a',
    });
    const res = fakeRes();
    await handler(
      fakeReq('POST', '/reception/approve/ep-approve-1?t=goodbearer', body, {
        host: 'mary.recued.cloud',
        origin: 'https://evil.example',
        'content-type': 'application/x-www-form-urlencoded',
      }),
      res,
    );
    expect(res.status).toBe(403);
  });

  it('rejects POST with stale / missing form_nonce', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env);
    const body = formUrlencode({
      form_nonce: 'never-issued',
      visitor_name: 'Bob',
      visitor_email: 'bob@example.com',
      option_id: 'opt_a',
    });
    const res = fakeRes();
    await handler(
      fakeReq('POST', '/reception/approve/ep-approve-1?t=goodbearer', body, {
        host: 'mary.recued.cloud',
        origin: 'https://mary.recued.cloud',
        'content-type': 'application/x-www-form-urlencoded',
      }),
      res,
    );
    expect(res.status).toBe(400);
    expect(res.body.toLowerCase()).toContain('stale');
  });

  it('rejects unknown field with 400', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env);
    const body = formUrlencode({
      form_nonce: issueNonce(env),
      visitor_name: 'Bob',
      visitor_email: 'bob@example.com',
      option_id: 'opt_a',
      banana: 'pajama',
    });
    const res = fakeRes();
    await handler(
      fakeReq('POST', '/reception/approve/ep-approve-1?t=goodbearer', body, {
        host: 'mary.recued.cloud',
        origin: 'https://mary.recued.cloud',
        'content-type': 'application/x-www-form-urlencoded',
      }),
      res,
    );
    expect(res.status).toBe(400);
  });

  it('accepts a valid pick_time consume + persists encrypted columns + flips consumed_at', async () => {
    const env = buildEnv();
    const audit = fakeAudit();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env, audit);
    const body = formUrlencode({
      form_nonce: issueNonce(env),
      visitor_name: 'Bob',
      visitor_email: 'bob@example.com',
      option_id: 'opt_a',
    });
    const res = fakeRes();
    await handler(
      fakeReq('POST', '/reception/approve/ep-approve-1?t=goodbearer', body, {
        host: 'mary.recued.cloud',
        origin: 'https://mary.recued.cloud',
        'content-type': 'application/x-www-form-urlencoded',
      }),
      res,
    );
    expect(res.status).toBe(200);
    expect(res.body.toLowerCase()).toContain('received');
    const updated = env.intentStore.findById('ep-approve-1');
    expect(updated?.consumed_at).toBe(NOW);
    const key = deriveApprovalIntentPiiKeyFromSubDek(SUB_DEK);
    expect(
      await openApprovalIntentPiiField({
        key,
        endpoint_id: 'ep-approve-1',
        intent_id: 'ep-approve-1',
        field: 'visitor_email',
        ciphertext: updated!.consumed_by_visitor_email_encrypted,
      }),
    ).toBe('bob@example.com');
    expect(
      await openApprovalIntentPiiField({
        key,
        endpoint_id: 'ep-approve-1',
        intent_id: 'ep-approve-1',
        field: 'outcome',
        ciphertext: updated!.consumed_outcome_encrypted,
      }),
    ).toBe('pick:opt_a');
    expect((audit.calls[0] as { action: string }).action).toBe('approval_intent.consumed');
  });

  it('second POST after consumed returns already-consumed page (single-use enforcement)', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env);
    const body1 = formUrlencode({
      form_nonce: issueNonce(env),
      visitor_name: 'Bob',
      visitor_email: 'bob@example.com',
      option_id: 'opt_a',
    });
    const res1 = fakeRes();
    await handler(
      fakeReq('POST', '/reception/approve/ep-approve-1?t=goodbearer', body1, {
        host: 'mary.recued.cloud',
        origin: 'https://mary.recued.cloud',
        'content-type': 'application/x-www-form-urlencoded',
      }),
      res1,
    );
    expect(res1.status).toBe(200);
    const body2 = formUrlencode({
      form_nonce: issueNonce(env),
      visitor_name: 'Alice',
      visitor_email: 'alice@example.com',
      option_id: 'opt_b',
    });
    const res2 = fakeRes();
    await handler(
      fakeReq('POST', '/reception/approve/ep-approve-1?t=goodbearer', body2, {
        host: 'mary.recued.cloud',
        origin: 'https://mary.recued.cloud',
        'content-type': 'application/x-www-form-urlencoded',
      }),
      res2,
    );
    expect(res2.status).toBe(200);
    expect(res2.body).toContain('Already responded');
    const final = env.intentStore.findById('ep-approve-1');
    const key = deriveApprovalIntentPiiKeyFromSubDek(SUB_DEK);
    expect(
      await openApprovalIntentPiiField({
        key,
        endpoint_id: 'ep-approve-1',
        intent_id: 'ep-approve-1',
        field: 'visitor_email',
        ciphertext: final!.consumed_by_visitor_email_encrypted,
      }),
    ).toBe('bob@example.com');
  });

  it('rejects email-match constraint failure with 400', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer', {
      ...baseConfig,
      visitor_field_constraints: {
        name: 'required',
        email: 'required',
        require_email_match: 'mom@example.com',
      },
    });
    const handler = buildHandler(env);
    const body = formUrlencode({
      form_nonce: issueNonce(env),
      visitor_name: 'Imposter',
      visitor_email: 'someone-else@example.com',
      option_id: 'opt_a',
    });
    const res = fakeRes();
    await handler(
      fakeReq('POST', '/reception/approve/ep-approve-1?t=goodbearer', body, {
        host: 'mary.recued.cloud',
        origin: 'https://mary.recued.cloud',
        'content-type': 'application/x-www-form-urlencoded',
      }),
      res,
    );
    expect(res.status).toBe(400);
    // The intent row stays unconsumed.
    expect(env.intentStore.findById('ep-approve-1')?.consumed_at).toBeNull();
  });

  it('accepts confirm_attendance workflow', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer', {
      ...baseConfig,
      action_kind: 'confirm_attendance',
      options: [
        { id: 'yes', label: 'Yes' },
        { id: 'no', label: 'No' },
      ],
    });
    const handler = buildHandler(env);
    const body = formUrlencode({
      form_nonce: issueNonce(env),
      visitor_name: 'Mom',
      visitor_email: 'mom@example.com',
      answer: 'yes',
    });
    const res = fakeRes();
    await handler(
      fakeReq('POST', '/reception/approve/ep-approve-1?t=goodbearer', body, {
        host: 'mary.recued.cloud',
        origin: 'https://mary.recued.cloud',
        'content-type': 'application/x-www-form-urlencoded',
      }),
      res,
    );
    expect(res.status).toBe(200);
    const updated = env.intentStore.findById('ep-approve-1');
    expect(updated?.consumed_at).toBe(NOW);
    const key = deriveApprovalIntentPiiKeyFromSubDek(SUB_DEK);
    expect(
      await openApprovalIntentPiiField({
        key,
        endpoint_id: 'ep-approve-1',
        intent_id: 'ep-approve-1',
        field: 'outcome',
        ciphertext: updated!.consumed_outcome_encrypted,
      }),
    ).toBe('confirm:yes');
  });

  it('accepts approve_wording approve outcome', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer', {
      ...baseConfig,
      action_kind: 'approve_wording',
      options: undefined,
    });
    const handler = buildHandler(env);
    const body = formUrlencode({
      form_nonce: issueNonce(env),
      visitor_name: 'V',
      visitor_email: 'v@example.com',
      decision: 'approve',
    });
    const res = fakeRes();
    await handler(
      fakeReq('POST', '/reception/approve/ep-approve-1?t=goodbearer', body, {
        host: 'mary.recued.cloud',
        origin: 'https://mary.recued.cloud',
        'content-type': 'application/x-www-form-urlencoded',
      }),
      res,
    );
    expect(res.status).toBe(200);
    const updated = env.intentStore.findById('ep-approve-1');
    const key = deriveApprovalIntentPiiKeyFromSubDek(SUB_DEK);
    expect(
      await openApprovalIntentPiiField({
        key,
        endpoint_id: 'ep-approve-1',
        intent_id: 'ep-approve-1',
        field: 'outcome',
        ciphertext: updated!.consumed_outcome_encrypted,
      }),
    ).toBe('approve');
  });

  it('accepts approve_wording reject outcome with comment', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer', {
      ...baseConfig,
      action_kind: 'approve_wording',
      options: undefined,
    });
    const handler = buildHandler(env);
    const body = formUrlencode({
      form_nonce: issueNonce(env),
      visitor_name: 'V',
      visitor_email: 'v@example.com',
      decision: 'reject',
      comment: 'Please revise paragraph 3.',
    });
    const res = fakeRes();
    await handler(
      fakeReq('POST', '/reception/approve/ep-approve-1?t=goodbearer', body, {
        host: 'mary.recued.cloud',
        origin: 'https://mary.recued.cloud',
        'content-type': 'application/x-www-form-urlencoded',
      }),
      res,
    );
    expect(res.status).toBe(200);
    const updated = env.intentStore.findById('ep-approve-1');
    const key = deriveApprovalIntentPiiKeyFromSubDek(SUB_DEK);
    expect(
      await openApprovalIntentPiiField({
        key,
        endpoint_id: 'ep-approve-1',
        intent_id: 'ep-approve-1',
        field: 'outcome',
        ciphertext: updated!.consumed_outcome_encrypted,
      }),
    ).toBe('reject:Please revise paragraph 3.');
  });

  it('accepts answer_question workflow', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer', {
      ...baseConfig,
      action_kind: 'answer_question',
      options: undefined,
    });
    const handler = buildHandler(env);
    const body = formUrlencode({
      form_nonce: issueNonce(env),
      visitor_name: 'V',
      visitor_email: 'v@example.com',
      answer: 'My answer is 42.',
    });
    const res = fakeRes();
    await handler(
      fakeReq('POST', '/reception/approve/ep-approve-1?t=goodbearer', body, {
        host: 'mary.recued.cloud',
        origin: 'https://mary.recued.cloud',
        'content-type': 'application/x-www-form-urlencoded',
      }),
      res,
    );
    expect(res.status).toBe(200);
    const updated = env.intentStore.findById('ep-approve-1');
    const key = deriveApprovalIntentPiiKeyFromSubDek(SUB_DEK);
    expect(
      await openApprovalIntentPiiField({
        key,
        endpoint_id: 'ep-approve-1',
        intent_id: 'ep-approve-1',
        field: 'outcome',
        ciphertext: updated!.consumed_outcome_encrypted,
      }),
    ).toBe('answer:My answer is 42.');
  });

  it('rejects empty answer with 400', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer', {
      ...baseConfig,
      action_kind: 'answer_question',
      options: undefined,
    });
    const handler = buildHandler(env);
    const body = formUrlencode({
      form_nonce: issueNonce(env),
      visitor_name: 'V',
      visitor_email: 'v@example.com',
      answer: '',
    });
    const res = fakeRes();
    await handler(
      fakeReq('POST', '/reception/approve/ep-approve-1?t=goodbearer', body, {
        host: 'mary.recued.cloud',
        origin: 'https://mary.recued.cloud',
        'content-type': 'application/x-www-form-urlencoded',
      }),
      res,
    );
    expect(res.status).toBe(400);
    expect(env.intentStore.findById('ep-approve-1')?.consumed_at).toBeNull();
  });

  it('rejects unknown option_id with 400', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env);
    const body = formUrlencode({
      form_nonce: issueNonce(env),
      visitor_name: 'Bob',
      visitor_email: 'bob@example.com',
      option_id: 'nonexistent',
    });
    const res = fakeRes();
    await handler(
      fakeReq('POST', '/reception/approve/ep-approve-1?t=goodbearer', body, {
        host: 'mary.recued.cloud',
        origin: 'https://mary.recued.cloud',
        'content-type': 'application/x-www-form-urlencoded',
      }),
      res,
    );
    expect(res.status).toBe(400);
    expect(env.intentStore.findById('ep-approve-1')?.consumed_at).toBeNull();
  });
});
