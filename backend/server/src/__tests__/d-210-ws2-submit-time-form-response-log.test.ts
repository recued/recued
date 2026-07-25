/** D-210 WS2 — the canonical `form_response` log is written at SUBMIT.
 *
 *  This is the whole rule matrix in one place, driven through the REAL intake
 *  POST handler with a REAL submission store and a REAL `form_response` store
 *  on the same in-memory database. What it pins:
 *
 *    1. UNPAIRED + `pending`  → LOGGED, with the submitted values, the frozen
 *       definition snapshot, and the visitor email — before any approval.
 *    2. UNPAIRED + `spam`     → NOT logged (the encrypted row is still kept for
 *       the abuse inbox; the canonical log is only for accepted submissions).
 *    3. UNPAIRED + `rejected_domain` → NOT logged. Owner ruling: a rejected
 *       domain is not spam, but it is not accepted either.
 *    4. AUTO-ACCEPT log-only  → LOGGED. This is the GAP WS2 EXISTS TO CLOSE:
 *       an auto-accepting endpoint never reaches the approve-time pre-resume
 *       hook, so before WS2 its submissions were recorded nowhere readable.
 *    5. PAIRED                → NOT logged here (a D-200 direct-checkout log is
 *       the paid deliverable and is written only after the approve-time payment
 *       gate). Covered from the pair side in `d-200-slice6g2` /
 *       `d-207-slice2c`; restated here so the matrix is complete in one read.
 *
 *  ⚠ WHY THIS FILE EXISTS: rules 2 and 3 were invisible to every pre-existing
 *  suite. The spam/rejected-domain tests that looked like coverage all used
 *  PAIRED forms, so the pair exclusion suppressed the write on its own and
 *  deleting the outcome gate entirely left the suite green. An unpaired spam
 *  submission had no test at all. Found by mutation, not by reading.
 *
 *  Spec: `docs/d-210-spec.md`; the write site is
 *  `ports/reception/handlers/intake-form.ts`. */

import Database from 'better-sqlite3';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { IntakeFormConfig } from '@recued/contracts';
import type { AuditLogStore } from '@recued/storage';
import {
  createInMemoryIntakeFormNonceStore,
  createIntakeFormPacketHandler,
  createIntakeFormSubmitHandler,
} from '../ports/reception/handlers/intake-form.js';
import { deriveFormSubmissionPiiKeyFromSubDek } from '../ports/reception/form-pii.js';
import type { ReceptionEndpointContext } from '../ports/reception/redacted-packet.js';
import { createReceptionFormSubmissionStore } from '../storage/reception-form-store.js';
import { createFormResponseStore } from '../storage/form-response-store.js';
import { ensureReceptionSchema } from '../storage/reception-store.js';

const NOW = 1_700_000_000_000;
const ENDPOINT_ID = 'ep-ws2-log';
const FORM_DEFINITION_ID = 'enquiry-v1';
const PII_KEY = deriveFormSubmissionPiiKeyFromSubDek(new Uint8Array(32).fill(0x6e));

/** A plain, unpaired intake. LOG-ONLY by default (no `target_kind`). */
const formConfig = (overrides: {
  auto_accept?: boolean;
  honeypot?: boolean;
  allowlist?: ReadonlyArray<string>;
  /** D-210 A.8 slice 2b — the destination. Defaults to `form_response`, which
   *  is what an absent target_kind used to mean before step 3 retired it. */
  target_kind?: 'task' | 'form_response';
} = {}): IntakeFormConfig => ({
  display_name: 'Ask us anything',
  success_message: 'Thanks.',
  form_definition: {
    form_definition_id: FORM_DEFINITION_ID,
    fields: [
      { name: 'topic', type: 'text', label: 'Topic', required: true },
      { name: 'details', type: 'textarea', label: 'Details', required: true },
      ...(overrides.honeypot
        ? [{ name: 'website', type: 'text' as const, label: 'Website', required: false }]
        : []),
    ],
  },
  submission_processing_rule: {
    target_kind: overrides.target_kind ?? 'form_response',
    // A real destination must PLACE every visible non-honeypot field
    // (`field_not_placed`, A.8 slice 2b) — otherwise the entity would discard
    // what the visitor typed and this row is the only thing that held it.
    fields_to_include_in_target: overrides.target_kind === 'task' ? ['topic', 'details'] : [],
    fields_to_attach_as_metadata: [],
    ...(overrides.auto_accept === true ? { auto_accept: true } : {}),
  },
  anti_spam: {
    honeypot_fields: overrides.honeypot ? ['website'] : [],
    rate_limit_per_ip: 20,
    require_proof_of_work: false,
    require_captcha: false,
    ...(overrides.allowlist ? { known_domain_allowlist: overrides.allowlist } : {}),
  },
  required_visitor_fields: { email: 'required' },
});

const fakeReq = (method: 'GET' | 'POST', body?: string): IncomingMessage => {
  const req = new IncomingMessage(new Socket());
  req.method = method;
  req.url = `/reception/intake/${ENDPOINT_ID}?t=test-bearer`;
  req.headers.host = 'localhost';
  if (method === 'POST') {
    req.headers.origin = 'http://localhost';
    req.headers['content-type'] = 'application/x-www-form-urlencoded';
  }
  if (body !== undefined) {
    setImmediate(() => {
      req.emit('data', Buffer.from(body, 'utf8'));
      req.emit('end');
    });
  }
  return req;
};

const fakeRes = () => {
  const chunks: Array<string | Buffer> = [];
  return {
    statusCode: 200,
    setHeader() {},
    getHeader() { return undefined; },
    write(chunk: string | Buffer) { chunks.push(chunk); },
    end(chunk?: string | Buffer) { if (chunk !== undefined) chunks.push(chunk); },
    get body() { return chunks.map(String).join(''); },
  } as unknown as ServerResponse & { readonly body: string };
};

const endpoint: ReceptionEndpointContext = {
  endpoint_id: ENDPOINT_ID,
  kind: 'intake_form_packet',
};

/** Render the form (for its single-use nonce), then POST it through the real
 *  handler over real stores. Returns what actually landed in both tables. */
const submit = async (input: {
  config: IntakeFormConfig;
  email: string;
  honeypotValue?: string;
}) => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  const submissionStore = createReceptionFormSubmissionStore(db);
  const responseStore = createFormResponseStore(db);
  const nonceStore = createInMemoryIntakeFormNonceStore();
  const registry = {
    findById: (id: string) => (id === ENDPOINT_ID ? { metadata: input.config } : null),
  };
  const created: string[] = [];

  const getRes = fakeRes();
  await createIntakeFormPacketHandler({
    getStore: () => registry as never,
    getFormNonceStore: () => nonceStore,
    now: () => NOW,
  })(fakeReq('GET'), getRes, endpoint);
  const nonce = /name="form_nonce" value="([^"]+)"/.exec(getRes.body)?.[1];
  expect(nonce).toBeTruthy();

  const postRes = fakeRes();
  await createIntakeFormSubmitHandler({
    getStore: () => registry as never,
    getSubmissionStore: () => submissionStore,
    getFormResponseStore: () => responseStore,
    getFormNonceStore: () => nonceStore,
    getFormSubmissionPiiKey: () => PII_KEY,
    auditLog: { logActivity: async () => undefined } as unknown as AuditLogStore,
    onFormResponseCreated: (response) => created.push(response.submission_id),
    now: () => NOW,
  })(
    fakeReq('POST', new URLSearchParams({
      form_nonce: nonce!,
      visitor_email: input.email,
      topic: 'Pricing',
      details: 'How much for the enterprise tier?',
      ...(input.honeypotValue !== undefined ? { website: input.honeypotValue } : {}),
    }).toString()),
    postRes,
    endpoint,
  );

  const row = db
    .prepare('SELECT submission_id, processing_outcome FROM reception_form_submission')
    .get() as { submission_id: string; processing_outcome: string } | undefined;
  const logged = responseStore.list();
  db.close();
  return { status: postRes.statusCode, row, logged, created };
};

describe('D-210 WS2 — the canonical form_response log is written at submit', () => {
  it('logs an accepted UNPAIRED submission before any approval, with its values sealed nowhere else', async () => {
    const seen = await submit({ config: formConfig(), email: 'lead@example.com' });

    expect(seen.status).toBe(200);
    expect(seen.row?.processing_outcome).toBe('pending');
    expect(seen.logged).toHaveLength(1);
    // The row is the SUBMISSION, in full — not a projection of it. The handler
    // had the plaintext in hand pre-sealing, so nothing here required a key.
    expect(seen.logged[0]).toMatchObject({
      submission_id: seen.row?.submission_id,
      endpoint_id: ENDPOINT_ID,
      form_definition_id: FORM_DEFINITION_ID,
      values: { topic: 'Pricing', details: 'How much for the enterprise tier?' },
      visitor: { email: 'lead@example.com' },
      submitted_at: NOW,
      accepted_at: NOW,
      origin_actor: 'anonymous',
    });
    // The frozen definition travels with it, so a later form edit cannot
    // reinterpret these answers under different labels.
    expect(seen.logged[0]?.definition_snapshot).toEqual(formConfig().form_definition);
    // …and the first-create fan-out ran, so owner Data + the trigger bus see it
    // at submit rather than at approval.
    expect(seen.created).toEqual([seen.row?.submission_id]);
  });

  // ══════════════════════════════════════════════════════════════
  // D-210 A.8 slice 2b — the row is a DESTINATION, not an always-on log.
  // ══════════════════════════════════════════════════════════════

  it('does NOT log a submission whose destination is something ELSE', async () => {
    const seen = await submit({
      config: formConfig({ target_kind: 'task' }),
      email: 'lead@example.com',
    });

    // Accepted and fully reviewable — this is not a rejection.
    expect(seen.status).toBe(200);
    expect(seen.row?.processing_outcome).toBe('pending');
    // …but its record is the TASK it will materialize, not a row here.
    expect(seen.logged).toEqual([]);
    // And no first-create fan-out fired, so owner Data and the trigger bus are
    // not told a response landed when none did.
    expect(seen.created).toEqual([]);
  });

  it('DOES log when the destination is form_response EXPLICITLY', async () => {
    const seen = await submit({
      config: formConfig({ target_kind: 'form_response' }),
      email: 'lead@example.com',
    });

    expect(seen.logged).toHaveLength(1);
    expect(seen.logged[0]).toMatchObject({
      values: { topic: 'Pricing', details: 'How much for the enterprise tier?' },
      // Born in the default state — the owner has not worked it yet.
      lifecycle_state: 'received',
      state_changed_at: 0,
    });
    expect(seen.created).toEqual([seen.row?.submission_id]);
  });

  it('has NO absent-target_kind case left — the synonym is retired', () => {
    // ⚠ This replaces a test that compared an ABSENT target_kind against an
    // explicit `form_response` to prove the two had not diverged. Step 3
    // deleted the absent spelling, so there is nothing to compare: the
    // contract requires the field and the validator refuses its absence.
    const rule = formConfig().submission_processing_rule as unknown as Record<string, unknown>;
    expect(rule.target_kind).toBe('form_response');
    expect(Object.hasOwn(rule, 'target_kind')).toBe(true);
  });

  it('does NOT log a spam submission, while still keeping the row', async () => {
    const seen = await submit({
      config: formConfig({ honeypot: true }),
      email: 'bot@example.com',
      honeypotValue: 'https://bot.example',
    });

    expect(seen.row?.processing_outcome).toBe('spam');
    expect(seen.logged).toEqual([]);
    expect(seen.created).toEqual([]);
  });

  it('does NOT log a rejected-domain submission (owner ruling: not spam, but not accepted)', async () => {
    const seen = await submit({
      config: formConfig({ allowlist: ['partner.example'] }),
      email: 'stranger@elsewhere.example',
      });

    expect(seen.row?.processing_outcome).toBe('rejected_domain');
    expect(seen.logged).toEqual([]);
    expect(seen.created).toEqual([]);
  });

  it('logs at SUBMIT, before anything decides what happens to the submission', async () => {
    // ⚠ D-210 Phase C RE-AIMED. This was the AUTO-ACCEPT case — before WS2 the
    // canonical record was minted by the approve-time pre-resume hook, which an
    // auto-accepting endpoint never reached, so its submissions were recorded
    // nowhere the owner could read. `auto_accept` is now retired on all three
    // reception kinds (owner ruling, 2026-07-18), so that particular gap can no
    // longer occur.
    //
    // WS2's guarantee is broader than the gap that motivated it, and THAT is
    // what this now pins: the log is written at SUBMIT, with the plaintext the
    // handler already holds, BEFORE the drain has looked at the row and long
    // before any approval. The row is still `pending` — nothing has decided
    // anything yet — and the log is already complete.
    const seen = await submit({
      config: formConfig(),
      email: 'lead@example.com',
    });

    // Untouched by the drain, and already logged.
    expect(seen.row?.processing_outcome).toBe('pending');
    expect(seen.logged).toHaveLength(1);
    expect(seen.logged[0]).toMatchObject({
      values: { topic: 'Pricing', details: 'How much for the enterprise tier?' },
      visitor: { email: 'lead@example.com' },
    });
  });
});
