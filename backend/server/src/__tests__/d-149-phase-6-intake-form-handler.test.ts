/** D-149 P6 § A.5.3 — intake_form GET + POST integration tests.
 *
 *  Covers:
 *    - Token-less request returns 401.
 *    - Authorized GET renders the form HTML + HTTP headers
 *      (CSP / no-store / X-Frame-Options DENY / Referrer-Policy
 *      no-referrer).
 *    - User-only metadata fields ABSENT from the rendered HTML
 *      (no-leak invariant per spec § A.5.3 line 760).
 *    - Honeypot fields ABSENT from the visitor packet but present in
 *      the rendered HTML (off-screen-positioned via the substrate CSS).
 *    - POST with valid form succeeds + persists a submission row + the
 *      submission_blob is sub_dek-encrypted (round-trips via the
 *      form-pii open helper).
 *    - POST rejects stale / missing form_nonce.
 *    - POST rejects mismatched Origin.
 *    - POST rejects unknown form fields.
 *    - POST tags honeypot-tripped submissions as `'spam'` + still
 *      returns 200 success (no bot signal).
 *    - POST tags email-domain-allowlist failures as `'rejected_domain'`.
 *    - 4xx / 5xx HTML pages still set the closed-list security headers. */

import Database from 'better-sqlite3';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { IntakeFormConfig } from '@recued/contracts';
import { ensureReceptionSchema } from '../storage/reception-store.js';
import { createPublicEndpointRegistryStore } from '../storage/public-endpoint-registry-store.js';
import { createReceptionFormSubmissionStore } from '../storage/reception-form-store.js';
import { createFormResponseStore } from '../storage/form-response-store.js';
import { createReceptionRateLimiter } from '../ports/reception/rate-limiter.js';
import { createReceptionRegistryCache } from '../ports/reception/registry-cache.js';
import {
  createReceptionPortHandler,
  type ReceptionPortHandlerDeps,
} from '../ports/reception/handler.js';
import {
  computeBearerHmac,
  deriveReceptionPepper,
} from '../ports/reception/server-secret-pepper.js';
import { createInMemoryIntakeFormNonceStore } from '../ports/reception/handlers/intake-form.js';
import {
  deriveFormSubmissionPiiKeyFromSubDek,
  openFormSubmissionField,
} from '../ports/reception/form-pii.js';
import type { AuditLogStore } from '@recued/storage';

const NOW = 1_700_000_000_000;
const SUB_DEK = new Uint8Array(32).fill(0x6e);
const PEPPER = deriveReceptionPepper(Buffer.alloc(32, 0xa1));
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
  const submission = createReceptionFormSubmissionStore(db);
  // D-210 WS2 — the canonical form_response log the POST path writes at submit.
  // A real store on the SAME db, not a stub: the POST readiness gate requires
  // it (a submission the substrate cannot record is not accepted), and several
  // tests below assert what actually landed in it.
  const formResponse = createFormResponseStore(db);
  const formNonce = createInMemoryIntakeFormNonceStore();
  return { db, store, cache, limiter, submission, formResponse, formNonce };
};

const goodConfig: IntakeFormConfig = {
  display_name: 'Mary Smith',
  instructions: 'Tell me about your project.',
  success_message: 'Got it — thanks!',
  submit_button_label: 'Send',
  form_definition: {
    form_definition_id: 'fd_client_inquiry_v1',
    fields: [
      { name: 'your_name', type: 'text', label: 'Your name', required: true },
      {
        name: 'service_interest',
        type: 'enum',
        label: 'What can I help with?',
        required: true,
        values: ['consulting', 'training', 'other'],
      },
      { name: 'details', type: 'textarea', label: 'Tell me more', required: true },
      // Honeypot — included in form_definition so the substrate's
      // closed-list gate accepts it as a honeypot name; absent from
      // visitor-visible packet.
      { name: 'website', type: 'text', label: 'Website', required: false },
    ],
    user_only_field_names: ['internal_classification', 'reliability_score'],
  },
  submission_processing_rule: {
    target_kind: 'task',
    fields_to_include_in_target: ['your_name', 'service_interest', 'details'],
    fields_to_attach_as_metadata: [],
  },
  anti_spam: {
    honeypot_fields: ['website'],
    rate_limit_per_ip: 5,
    require_proof_of_work: false,
    require_captcha: false,
  },
  required_visitor_fields: { email: 'required' },
};

const insertEndpoint = (
  env: ReturnType<typeof buildEnv>,
  bearer: string,
  config: IntakeFormConfig = goodConfig,
) => {
  const endpoint_id = 'ep-intake-1';
  env.store.create({
    endpoint_id,
    kind: 'intake_form',
    packet_declaration: {
      packet_kind: 'intake_form_packet',
      source_query_ref: {
        kind: 'reception_form_definition',
        form_definition_id: 'fd_client_inquiry_v1',
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
  return endpoint_id;
};

const fakeReq = (
  method: string,
  url: string,
  body?: string,
  headers?: Record<string, string>,
): IncomingMessage => {
  const socket = new Socket();
  Object.defineProperty(socket, 'remoteAddress', { value: '203.0.113.7' });
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

const buildHandler = (
  env: ReturnType<typeof buildEnv>,
  audit?: AuditLogStore,
  overrides: Partial<ReceptionPortHandlerDeps> = {},
) =>
  createReceptionPortHandler({
    getStore: () => env.store,
    getCache: () => env.cache,
    getRateLimiter: () => env.limiter,
    getPepper: () => PEPPER,
    now: () => NOW,
    getIntakeFormSubmissionStore: () => env.submission,
    getFormResponseStore: () => env.formResponse,
    getIntakeFormNonceStore: () => env.formNonce,
    getIntakeFormSubmissionPiiKey: () => deriveFormSubmissionPiiKeyFromSubDek(SUB_DEK),
    auditLog: audit ?? fakeAudit(),
    ...overrides,
  });

// ────────────────────────────────────────────────────────────────
// GET tests
// ────────────────────────────────────────────────────────────────

describe('D-149 P6 § A.5.3 — GET /reception/intake/<id>', () => {
  it('returns 401 when no token is supplied', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env);
    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/intake/ep-intake-1'), res);
    expect(res.status).toBe(401);
  });

  it('returns 200 with intake form HTML for a valid token', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env);
    const res = fakeRes();
    await handler(
      fakeReq('GET', '/reception/intake/ep-intake-1?t=goodbearer'),
      res,
    );
    expect(res.status).toBe(200);
    expect(res.getHeader('content-type')).toBe('text/html; charset=utf-8');
    expect(res.getHeader('cache-control')).toBe('no-store');
    expect(res.getHeader('x-frame-options')).toBe('DENY');
    expect(res.getHeader('referrer-policy')).toBe('no-referrer');
    expect(res.body).toContain('Send Mary Smith a message');
    expect(res.body).toContain("script-src 'none'");
    expect(res.body).toContain('action="/reception/intake/ep-intake-1?t=');
  });

  it('fails a ready paid pair closed when its claim adapter is not composed', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const binding = {
      version: 1 as const,
      form_definition_id: goodConfig.form_definition.form_definition_id,
      recipe_id: 'paid-recipe',
      recipe_version: 1,
      pair_revision: `d200-pair-v1-${'a'.repeat(64)}` as const,
    };
    const withoutClaim = buildHandler(env, undefined, {
      resolveIntakeFormRecipePair: () => ({ kind: 'ready', binding, renders_response: false }),
    });
    const blocked = fakeRes();
    await withoutClaim(
      fakeReq('GET', '/reception/intake/ep-intake-1?t=goodbearer'),
      blocked,
    );
    expect(blocked.status).toBe(503);

    const withClaim = buildHandler(env, undefined, {
      resolveIntakeFormRecipePair: () => ({ kind: 'ready', binding, renders_response: false }),
      coordinateIntakeFormPairedRun: async () => ({ kind: 'refused' }),
    });
    const live = fakeRes();
    await withClaim(
      fakeReq('GET', '/reception/intake/ep-intake-1?t=goodbearer'),
      live,
    );
    expect(live.status).toBe(200);
  });

  it('strips user_only fields from rendered HTML (no-leak invariant)', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env);
    const res = fakeRes();
    await handler(
      fakeReq('GET', '/reception/intake/ep-intake-1?t=goodbearer'),
      res,
    );
    expect(res.body).not.toContain('internal_classification');
    expect(res.body).not.toContain('reliability_score');
  });

  it('renders the configured visitor-visible fields', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env);
    const res = fakeRes();
    await handler(
      fakeReq('GET', '/reception/intake/ep-intake-1?t=goodbearer'),
      res,
    );
    expect(res.body).toContain('name="your_name"');
    expect(res.body).toContain('name="service_interest"');
    expect(res.body).toContain('name="details"');
    expect(res.body).toContain('value="consulting"');
  });

  it('renders honeypot field but tagged off-screen + tabindex=-1', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env);
    const res = fakeRes();
    await handler(
      fakeReq('GET', '/reception/intake/ep-intake-1?t=goodbearer'),
      res,
    );
    expect(res.body).toContain('rcp-honeypot');
    expect(res.body).toContain('aria-hidden="true"');
    expect(res.body).toContain('tabindex="-1"');
    expect(res.body).toContain('name="website"');
  });

  it('renders the visitor_email field when required', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env);
    const res = fakeRes();
    await handler(
      fakeReq('GET', '/reception/intake/ep-intake-1?t=goodbearer'),
      res,
    );
    expect(res.body).toContain('name="visitor_email"');
  });

  it('omits the visitor_email field when required_visitor_fields.email === omit', async () => {
    const env = buildEnv();
    const cfg = { ...goodConfig, required_visitor_fields: { email: 'omit' as const } };
    insertEndpoint(env, 'goodbearer', cfg);
    const handler = buildHandler(env);
    const res = fakeRes();
    await handler(
      fakeReq('GET', '/reception/intake/ep-intake-1?t=goodbearer'),
      res,
    );
    expect(res.body).not.toContain('name="visitor_email"');
  });

  it('renders placeholder when registry metadata is corrupt', async () => {
    const env = buildEnv();
    env.store.create({
      endpoint_id: 'ep-bad',
      kind: 'intake_form',
      packet_declaration: {
        packet_kind: 'intake_form_packet',
        source_query_ref: {
        kind: 'reception_form_definition',
        form_definition_id: 'fd_client_inquiry_v1',
      },
      },
      bearer_secret_hmac: computeBearerHmac('badcfg', PEPPER),
      created_at: NOW - DAY,
      created_by_client_id: 'inst-1',
      expires_at: null,
      long_lived_acknowledged_at: NOW - DAY,
      metadata: { not_a_config: true } as unknown as Record<string, unknown>,
    });
    env.store.enable('ep-bad', NOW);
    const handler = buildHandler(env);
    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/intake/ep-bad?t=badcfg'), res);
    expect(res.status).toBe(503);
    expect(res.body).toContain('not currently accepting');
  });
});

// ────────────────────────────────────────────────────────────────
// POST tests
// ────────────────────────────────────────────────────────────────

describe('D-149 P6 § A.5.3 — POST /reception/intake/<id>', () => {
  it('rejects POST when Origin header is missing', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env);
    const nonce = env.formNonce.issue('ep-intake-1', NOW);
    const body = `t=goodbearer&form_nonce=${nonce}&visitor_email=v%40example.com&your_name=Q&service_interest=consulting&details=hello`;
    const res = fakeRes();
    await handler(
      fakeReq('POST', '/reception/intake/ep-intake-1?t=goodbearer', body, {
        host: 'localhost',
        'content-type': 'application/x-www-form-urlencoded',
      }),
      res,
    );
    expect(res.status).toBe(403);
  });

  it('rejects POST when form_nonce is stale (already consumed)', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env);
    const nonce = env.formNonce.issue('ep-intake-1', NOW);
    env.formNonce.consume('ep-intake-1', nonce, NOW); // burn
    const body = `t=goodbearer&form_nonce=${nonce}&visitor_email=v%40example.com&your_name=Q&service_interest=consulting&details=hello`;
    const res = fakeRes();
    await handler(
      fakeReq('POST', '/reception/intake/ep-intake-1?t=goodbearer', body, {
        host: 'localhost',
        origin: 'http://localhost',
        'content-type': 'application/x-www-form-urlencoded',
      }),
      res,
    );
    expect(res.status).toBe(400);
    expect(res.body).toContain('reload the page');
  });

  it('rejects POST with unknown form field', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env);
    const nonce = env.formNonce.issue('ep-intake-1', NOW);
    const body = `t=goodbearer&form_nonce=${nonce}&visitor_email=v%40example.com&your_name=Q&service_interest=consulting&details=hello&surprise=extra`;
    const res = fakeRes();
    await handler(
      fakeReq('POST', '/reception/intake/ep-intake-1?t=goodbearer', body, {
        host: 'localhost',
        origin: 'http://localhost',
        'content-type': 'application/x-www-form-urlencoded',
      }),
      res,
    );
    expect(res.status).toBe(400);
    expect(res.body).toContain('unknown field');
  });

  it('persists a clean submission + returns 200 success', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const audit = fakeAudit();
    const handler = buildHandler(env, audit);
    const nonce = env.formNonce.issue('ep-intake-1', NOW);
    const body = `t=goodbearer&form_nonce=${nonce}&visitor_email=v%40example.com&your_name=Q&service_interest=consulting&details=hello`;
    const res = fakeRes();
    await handler(
      fakeReq('POST', '/reception/intake/ep-intake-1?t=goodbearer', body, {
        host: 'localhost',
        origin: 'http://localhost',
        'content-type': 'application/x-www-form-urlencoded',
      }),
      res,
    );
    expect(res.status).toBe(200);
    expect(res.body).toContain('Submission received');
    const rows = env.submission.listPendingForEndpoint('ep-intake-1');
    expect(rows.length).toBe(1);
    expect(rows[0]!.processing_outcome).toBe('pending');
    expect(rows[0]!.form_definition_id).toBe('fd_client_inquiry_v1');
    expect(rows[0]!.visitor_email_encrypted).not.toBeNull();
    expect(rows[0]!.metadata.definition_snapshot).toEqual(goodConfig.form_definition);
    expect((audit.calls as Array<{ action: string }>).some((c) => c.action === 'form_submission.received'))
      .toBe(true);
  });

  it('round-trips submission_blob via the AEAD key (decrypt matches plaintext)', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env);
    const nonce = env.formNonce.issue('ep-intake-1', NOW);
    const body = `t=goodbearer&form_nonce=${nonce}&visitor_email=v%40example.com&your_name=Q&service_interest=consulting&details=hello%20world`;
    const res = fakeRes();
    await handler(
      fakeReq('POST', '/reception/intake/ep-intake-1?t=goodbearer', body, {
        host: 'localhost',
        origin: 'http://localhost',
        'content-type': 'application/x-www-form-urlencoded',
      }),
      res,
    );
    const row = env.submission.listPendingForEndpoint('ep-intake-1')[0]!;
    const key = deriveFormSubmissionPiiKeyFromSubDek(SUB_DEK);
    const decrypted = await openFormSubmissionField({
      key,
      endpoint_id: 'ep-intake-1',
      submission_id: row.submission_id,
      field: 'submission_blob',
      ciphertext: row.submission_blob_encrypted,
    });
    expect(decrypted).not.toBeNull();
    const parsed = JSON.parse(decrypted!) as { fields: Record<string, unknown> };
    expect(parsed.fields.your_name).toBe('Q');
    expect(parsed.fields.service_interest).toBe('consulting');
    expect(parsed.fields.details).toBe('hello world');

    const decryptedEmail = await openFormSubmissionField({
      key,
      endpoint_id: 'ep-intake-1',
      submission_id: row.submission_id,
      field: 'visitor_email',
      ciphertext: row.visitor_email_encrypted,
    });
    expect(decryptedEmail).toBe('v@example.com');
  });

  it('returns 200 success but marks submission spam when honeypot is tripped', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env);
    const nonce = env.formNonce.issue('ep-intake-1', NOW);
    const body = `t=goodbearer&form_nonce=${nonce}&visitor_email=v%40example.com&your_name=Q&service_interest=consulting&details=hello&website=spamlink`;
    const res = fakeRes();
    await handler(
      fakeReq('POST', '/reception/intake/ep-intake-1?t=goodbearer', body, {
        host: 'localhost',
        origin: 'http://localhost',
        'content-type': 'application/x-www-form-urlencoded',
      }),
      res,
    );
    expect(res.status).toBe(200);
    expect(res.body).toContain('Submission received');
    const row = env.submission.listPendingForEndpoint('ep-intake-1');
    expect(row.length).toBe(0); // not pending — already terminal
    const rowMeta = env.db
      .prepare('SELECT submission_id FROM reception_form_submission')
      .get() as { submission_id: string };
    const all = env.submission.findById(rowMeta.submission_id);
    expect(all?.processing_outcome).toBe('spam');
    expect((all?.metadata as { honeypots_tripped?: string[] }).honeypots_tripped).toEqual([
      'website',
    ]);
  });

  it('tags submission rejected_domain when email outside allowlist', async () => {
    const env = buildEnv();
    const cfg: IntakeFormConfig = {
      ...goodConfig,
      anti_spam: { ...goodConfig.anti_spam, known_domain_allowlist: ['client.com'] },
    };
    insertEndpoint(env, 'goodbearer', cfg);
    const handler = buildHandler(env);
    const nonce = env.formNonce.issue('ep-intake-1', NOW);
    const body = `t=goodbearer&form_nonce=${nonce}&visitor_email=v%40bad.com&your_name=Q&service_interest=consulting&details=hello`;
    const res = fakeRes();
    await handler(
      fakeReq('POST', '/reception/intake/ep-intake-1?t=goodbearer', body, {
        host: 'localhost',
        origin: 'http://localhost',
        'content-type': 'application/x-www-form-urlencoded',
      }),
      res,
    );
    expect(res.status).toBe(200);
    const submissionRow = env.db
      .prepare(
        'SELECT submission_id, processing_outcome FROM reception_form_submission LIMIT 1',
      )
      .get() as { submission_id: string; processing_outcome: string };
    expect(submissionRow.processing_outcome).toBe('rejected_domain');
  });

  it('drops visitor_email at the parse boundary when required_visitor_fields.email === omit (Codex P2 #2)', async () => {
    const env = buildEnv();
    const cfg: IntakeFormConfig = {
      ...goodConfig,
      required_visitor_fields: { email: 'omit' },
    };
    insertEndpoint(env, 'goodbearer', cfg);
    const handler = buildHandler(env);
    const nonce = env.formNonce.issue('ep-intake-1', NOW);
    // A crafted POST that includes `visitor_email` for an omit-mode
    // form must NOT persist the email — neither in the dedicated
    // ciphertext column nor in the submission_blob payload.
    const body = `t=goodbearer&form_nonce=${nonce}&visitor_email=leak%40bad.com&your_name=Q&service_interest=consulting&details=hello`;
    const res = fakeRes();
    await handler(
      fakeReq('POST', '/reception/intake/ep-intake-1?t=goodbearer', body, {
        host: 'localhost',
        origin: 'http://localhost',
        'content-type': 'application/x-www-form-urlencoded',
      }),
      res,
    );
    expect(res.status).toBe(200);
    const row = env.submission.listPendingForEndpoint('ep-intake-1')[0]!;
    expect(row.visitor_email_encrypted).toBeNull();
    const key = deriveFormSubmissionPiiKeyFromSubDek(SUB_DEK);
    const decrypted = await openFormSubmissionField({
      key,
      endpoint_id: 'ep-intake-1',
      submission_id: row.submission_id,
      field: 'submission_blob',
      ciphertext: row.submission_blob_encrypted,
    });
    expect(decrypted).not.toBeNull();
    const parsed = JSON.parse(decrypted!) as { visitor_email?: string };
    expect(parsed.visitor_email).toBeUndefined();
  });

  it('enforces the per-form anti_spam.rate_limit_per_ip rolling window (Codex P2 #1)', async () => {
    const env = buildEnv();
    const cfg: IntakeFormConfig = {
      ...goodConfig,
      anti_spam: { ...goodConfig.anti_spam, rate_limit_per_ip: 2 },
    };
    insertEndpoint(env, 'goodbearer', cfg);
    const handler = buildHandler(env);

    const submitOnce = async (n: number): Promise<{ status: number; body: string }> => {
      const nonce = env.formNonce.issue('ep-intake-1', NOW);
      const body = `t=goodbearer&form_nonce=${nonce}&visitor_email=v${n}%40example.com&your_name=Q${n}&service_interest=consulting&details=hello`;
      const res = fakeRes();
      await handler(
        fakeReq('POST', '/reception/intake/ep-intake-1?t=goodbearer', body, {
          host: 'localhost',
          origin: 'http://localhost',
          'content-type': 'application/x-www-form-urlencoded',
        }),
        res,
      );
      return { status: res.status, body: res.body };
    };

    expect((await submitOnce(1)).status).toBe(200);
    expect((await submitOnce(2)).status).toBe(200);
    // Third submission within the rolling hour MUST be rate-limited.
    const blocked = await submitOnce(3);
    expect(blocked.status).toBe(429);
    expect(blocked.body).toContain('hourly submission limit');
  });

  it('rejects POST when a required visitor field is missing', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env);
    const nonce = env.formNonce.issue('ep-intake-1', NOW);
    // Omit `details` which is required
    const body = `t=goodbearer&form_nonce=${nonce}&visitor_email=v%40example.com&your_name=Q&service_interest=consulting`;
    const res = fakeRes();
    await handler(
      fakeReq('POST', '/reception/intake/ep-intake-1?t=goodbearer', body, {
        host: 'localhost',
        origin: 'http://localhost',
        'content-type': 'application/x-www-form-urlencoded',
      }),
      res,
    );
    expect(res.status).toBe(400);
  });

  it('rejects PUT / DELETE / etc. with 405', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env);
    const res = fakeRes();
    await handler(
      fakeReq('PUT', '/reception/intake/ep-intake-1?t=goodbearer', '', {
        host: 'localhost',
        origin: 'http://localhost',
      }),
      res,
    );
    expect(res.status).toBe(405);
    expect(res.getHeader('allow')).toBe('GET, POST');
  });

  it('rejects requests with additional path segments with 404', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env);
    const res = fakeRes();
    await handler(
      fakeReq('GET', '/reception/intake/ep-intake-1/extra?t=goodbearer', undefined, {
        host: 'localhost',
      }),
      res,
    );
    expect(res.status).toBe(404);
  });
});

// ────────────────────────────────────────────────────────────────
// Deps-absent fallback (503 stub) — mirrors the P5 scheduling
// dispatcher's degraded posture
// ────────────────────────────────────────────────────────────────

describe('D-149 P6 § A.5.3 — degraded posture', () => {
  it('falls back to 503 stub when intake_form deps are absent (GET)', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = createReceptionPortHandler({
      getStore: () => env.store,
      getCache: () => env.cache,
      getRateLimiter: () => env.limiter,
      getPepper: () => PEPPER,
      now: () => NOW,
      // Intake-form deps deliberately omitted — the dispatcher falls
      // through to the kind-registry 503 stub for GET.
      auditLog: fakeAudit(),
    });
    const res = fakeRes();
    await handler(
      fakeReq('GET', '/reception/intake/ep-intake-1?t=goodbearer'),
      res,
    );
    expect(res.status).toBe(503);
    expect(res.body).toContain('not_implemented');
  });

  it('falls back to 503 not_configured when intake_form deps are absent (POST)', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = createReceptionPortHandler({
      getStore: () => env.store,
      getCache: () => env.cache,
      getRateLimiter: () => env.limiter,
      getPepper: () => PEPPER,
      now: () => NOW,
      auditLog: fakeAudit(),
    });
    const res = fakeRes();
    const nonce = 'irrelevant';
    const body = `t=goodbearer&form_nonce=${nonce}&visitor_email=v%40example.com&your_name=Q&service_interest=consulting&details=hello`;
    await handler(
      fakeReq('POST', '/reception/intake/ep-intake-1?t=goodbearer', body, {
        host: 'localhost',
        origin: 'http://localhost',
        'content-type': 'application/x-www-form-urlencoded',
      }),
      res,
    );
    expect(res.status).toBe(503);
    expect(res.body).toContain('not_configured');
  });
});
