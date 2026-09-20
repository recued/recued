/** D-145 PB2 — high-assurance RecuedPlan signing tests.
 *
 *  Acceptance per spec § B.5 + § B.5.4 + § A.2.5:
 *   - Sign a high-assurance plan → signature populated.
 *   - Verifier reads + verifies against the server public key.
 *   - Tampered plan fails verify.
 *   - Non-high-assurance plans pass through unchanged (no signature).
 *   - Signing wrapper redacts user_request before signing when
 *     `audit_policy.redact_user_request: true` (signature commits to
 *     the redacted bytes, not the raw user input).
 *   - Wrapper picks up the *current* server identity at each call
 *     (post-rotation writes use the new key).
 *   - Verifier surfaces the failure reason in a closed taxonomy.
 *   - Rotation-aware verify via `PlanPublicKeyResolver` function. */

import { describe, expect, it } from 'vitest';

import {
  REDACTED_USER_REQUEST_MARKER,
  type RecuedPlan,
} from '@recued/contracts';
import {
  createInMemoryCollection,
  createRecuedPlanStore,
  type RecuedPlanStore,
} from '@recued/storage';
import { generateEd25519Keypair } from '../keys/index.js';
import {
  createSigningRecuedPlanStore,
  isRecuedPlanTampered,
  signRecuedPlan,
  verifyRecuedPlan,
} from '../recued-plan/signing.js';

const baseSelectionTrace = () => ({
  recipe_candidates_considered: 0,
  recipe_candidates_selected: [],
  recipe_candidates_dropped: [],
  commitment_context_pulled: false,
  commitment_rows_count: 0,
  catalog_section_counts: {},
  catalog_short_circuited: false,
});

const buildPlan = (overrides: Partial<RecuedPlan> = {}): RecuedPlan => ({
  plan_id: 'plan-001',
  goal_id: 'goal-001',
  user_request: 'baseline request',
  considered_sources: [],
  capacity_checks: [],
  included_context: [],
  omitted_context: [],
  selection_trace: baseSelectionTrace(),
  model_tier: 'fast',
  ai_provider: 'anthropic',
  ai_model_id: 'claude-haiku-4-5',
  primitive_calls: [],
  status: 'completed',
  user_visible_internal_steps: [],
  user_response: 'ok',
  user_events: [],
  provenance_links: [],
  audit_policy: {
    retain_for_days: 90,
    high_assurance: false,
    redact_user_request: false,
  },
  started_at: 1_736_000_000_000,
  completed_at: 1_736_000_001_000,
  ...overrides,
});

const makeBaseStore = (): RecuedPlanStore =>
  createRecuedPlanStore(createInMemoryCollection<RecuedPlan>());

describe('D-145 PB2 — signRecuedPlan + verifyRecuedPlan round-trip', () => {
  it('signs + verifies a high-assurance plan', () => {
    const server_identity = generateEd25519Keypair('server_identity_key');
    const plan = buildPlan({
      audit_policy: {
        retain_for_days: 90,
        high_assurance: true,
        redact_user_request: false,
      },
    });
    const signed = signRecuedPlan(plan, server_identity);
    expect(typeof signed.signature).toBe('string');
    expect(signed.signature!.length).toBeGreaterThan(0);
    expect(signed.signer_fingerprint).toBe(server_identity.public_key_fingerprint);
    const result = verifyRecuedPlan(signed, server_identity.public_key_b64);
    expect(result.ok).toBe(true);
  });

  it('verify fails when plan is tampered', () => {
    const server_identity = generateEd25519Keypair('server_identity_key');
    const plan = buildPlan({
      audit_policy: {
        retain_for_days: 90,
        high_assurance: true,
        redact_user_request: false,
      },
    });
    const signed = signRecuedPlan(plan, server_identity);
    const tampered: RecuedPlan = {
      ...signed,
      user_response: 'attacker-rewritten-response',
    };
    const result = verifyRecuedPlan(tampered, server_identity.public_key_b64);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('signature_invalid');
  });

  it('verify fails when signature missing', () => {
    const plan = buildPlan();
    const result = verifyRecuedPlan(plan, 'mock-base64');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('signature_missing');
  });

  it('verify fails when signature malformed', () => {
    const plan: RecuedPlan = { ...buildPlan(), signature: '' };
    const result = verifyRecuedPlan(plan, 'mock-base64');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('signature_malformed');
  });

  it('verify fails on empty pubkey', () => {
    const server_identity = generateEd25519Keypair('server_identity_key');
    const plan = signRecuedPlan(
      buildPlan({
        audit_policy: {
          retain_for_days: 90,
          high_assurance: true,
          redact_user_request: false,
        },
      }),
      server_identity,
    );
    const result = verifyRecuedPlan(plan, '');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('public_key_malformed');
  });

  it('different server identity fails verify', () => {
    const a = generateEd25519Keypair('server_identity_key');
    const b = generateEd25519Keypair('server_identity_key');
    const plan = signRecuedPlan(buildPlan(), a);
    const result = verifyRecuedPlan(plan, b.public_key_b64);
    expect(result.ok).toBe(false);
  });

  it('signature stripping is idempotent — re-sign produces same bytes', () => {
    const server_identity = generateEd25519Keypair('server_identity_key');
    const plan = buildPlan();
    const a = signRecuedPlan(plan, server_identity);
    const b = signRecuedPlan(a, server_identity);
    expect(b.signature).toBe(a.signature);
    expect(b.signer_fingerprint).toBe(a.signer_fingerprint);
  });

  it('Codex P2 fold — signRecuedPlan enforces redact-before-sign internally', () => {
    // § B.5.5 invariant: any signature ever produced commits to the
    // redacted bytes. Direct callers (PB3 orchestrator manual-write
    // paths / Dry Run replay / one-shot fixtures) must not be able
    // to bypass redaction by skipping the wrapper.
    const server_identity = generateEd25519Keypair('server_identity_key');
    const plan = buildPlan({
      user_request: 'sensitive data SSN 123-45-6789',
      audit_policy: {
        retain_for_days: 90,
        high_assurance: true,
        redact_user_request: true,
      },
    });
    const signed = signRecuedPlan(plan, server_identity);
    // The signed plan carries the redaction marker, NOT the raw
    // user_request — input is unchanged (pure function).
    expect(signed.user_request).toBe(REDACTED_USER_REQUEST_MARKER);
    expect(plan.user_request).toContain('SSN');
    // Signature verifies against the redacted bytes.
    const result = verifyRecuedPlan(signed, server_identity.public_key_b64);
    expect(result.ok).toBe(true);
  });

  it('Codex P2 fold — signRecuedPlan leaves non-redact-policy plans untouched', () => {
    const server_identity = generateEd25519Keypair('server_identity_key');
    const plan = buildPlan({
      user_request: 'normal request',
      audit_policy: {
        retain_for_days: 90,
        high_assurance: true,
        redact_user_request: false, // explicit opt-out
      },
    });
    const signed = signRecuedPlan(plan, server_identity);
    expect(signed.user_request).toBe('normal request');
  });

  it('Codex P2 fold — signRecuedPlan idempotent when input already redacted', () => {
    const server_identity = generateEd25519Keypair('server_identity_key');
    const plan = buildPlan({
      user_request: REDACTED_USER_REQUEST_MARKER,
      audit_policy: {
        retain_for_days: 90,
        high_assurance: true,
        redact_user_request: true,
      },
    });
    const signed = signRecuedPlan(plan, server_identity);
    // No double-redaction; user_request stays the marker.
    expect(signed.user_request).toBe(REDACTED_USER_REQUEST_MARKER);
    const result = verifyRecuedPlan(signed, server_identity.public_key_b64);
    expect(result.ok).toBe(true);
  });

  it('rotation-aware verify via PlanPublicKeyResolver function', () => {
    const v1 = generateEd25519Keypair('server_identity_key');
    const v2 = generateEd25519Keypair('server_identity_key');
    const plan = signRecuedPlan(buildPlan(), v1);
    // Resolver returns the right key based on fingerprint.
    const result = verifyRecuedPlan(plan, (fp) => {
      if (fp === v1.public_key_fingerprint) return v1.public_key_b64;
      if (fp === v2.public_key_fingerprint) return v2.public_key_b64;
      return null;
    });
    expect(result.ok).toBe(true);
  });

  it('resolver returning null fails with signer_fingerprint_unknown', () => {
    const v1 = generateEd25519Keypair('server_identity_key');
    const plan = signRecuedPlan(buildPlan(), v1);
    const result = verifyRecuedPlan(plan, () => null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('signer_fingerprint_unknown');
  });

  it('resolver path with missing signer_fingerprint surfaces signer_fingerprint_unknown', () => {
    // Plan signed without fingerprint (legacy / synthetic).
    const v1 = generateEd25519Keypair('server_identity_key');
    const signed = signRecuedPlan(buildPlan(), v1);
    const stripped: RecuedPlan = { ...signed };
    delete (stripped as { signer_fingerprint?: string }).signer_fingerprint;
    const result = verifyRecuedPlan(stripped, () => v1.public_key_b64);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('signer_fingerprint_unknown');
  });
});

describe('D-145 PB2 — isRecuedPlanTampered helper', () => {
  it('returns false on non-high-assurance plans regardless of signature', () => {
    const plan = buildPlan(); // high_assurance: false
    expect(isRecuedPlanTampered(plan, 'any-key')).toBe(false);
  });

  it('returns true on high-assurance plan missing signature', () => {
    const plan = buildPlan({
      audit_policy: {
        retain_for_days: 90,
        high_assurance: true,
        redact_user_request: false,
      },
    });
    expect(isRecuedPlanTampered(plan, 'any-key')).toBe(true);
  });

  it('returns false on properly-signed high-assurance plan', () => {
    const server_identity = generateEd25519Keypair('server_identity_key');
    const plan = signRecuedPlan(
      buildPlan({
        audit_policy: {
          retain_for_days: 90,
          high_assurance: true,
          redact_user_request: false,
        },
      }),
      server_identity,
    );
    expect(isRecuedPlanTampered(plan, server_identity.public_key_b64)).toBe(false);
  });
});

describe('D-145 PB2 — createSigningRecuedPlanStore wrapper', () => {
  it('passes through non-high-assurance plans unchanged (no signature)', async () => {
    const server_identity = generateEd25519Keypair('server_identity_key');
    const wrapped = createSigningRecuedPlanStore(makeBaseStore(), {
      getServerIdentity: () => server_identity,
    });
    const plan = buildPlan(); // high_assurance: false, redact_user_request: false
    await wrapped.append(plan);
    const got = await wrapped.get(plan.plan_id);
    expect(got?.signature).toBeUndefined();
    expect(got?.signer_fingerprint).toBeUndefined();
    // ⛔⛔ "UNCHANGED" IS NOW CHECKED, NOT JUST CLAIMED. This asserted only that
    // the two signature fields were absent — so a wrapper that redacted
    // REGARDLESS of policy passed it, and mutation confirmed that. The redaction
    // is not a no-op on such a plan: `redactUserRequest` replaces `user_request`
    // with the marker AND flips `audit_policy.redact_user_request` to true, so
    // the owner's own "keep my request" setting is overwritten by the act of
    // storing the plan, with nothing left to show what it was.
    expect(got, 'a pass-through plan came back altered').toEqual(plan);
  });

  it('⛔⛔ a plan whose policy says DO NOT redact keeps its request — signed or not', async () => {
    // ⚠ BOTH PATHS, because the redaction is applied at TWO layers: the wrapper
    // redacts so unsigned plans persist redacted, and `signRecuedPlan` redacts
    // again so a direct caller of the primitive cannot bypass it. Two layers
    // agreeing is why one of them losing its policy check was invisible — the
    // only fixture that can see it is a plan that opted OUT.
    const server_identity = generateEd25519Keypair('server_identity_key');
    const wrapped = createSigningRecuedPlanStore(makeBaseStore(), {
      getServerIdentity: () => server_identity,
    });
    for (const high_assurance of [false, true]) {
      const plan = buildPlan({
        plan_id: `plan-keep-${String(high_assurance)}`,
        user_request: 'please summarise my inbox',
        audit_policy: {
          retain_for_days: 90,
          high_assurance,
          redact_user_request: false,
        },
      });
      await wrapped.append(plan);
      const got = await wrapped.get(plan.plan_id);
      expect(
        got?.user_request,
        `high_assurance=${String(high_assurance)}: the request was redacted against policy`,
      ).toBe('please summarise my inbox');
      expect(
        got?.audit_policy.redact_user_request,
        `high_assurance=${String(high_assurance)}: the policy flag was overwritten`,
      ).toBe(false);
    }
  });

  it('⚠ and a plan that OPTS IN is redacted on both paths', async () => {
    // The complement, so the case above cannot pass under "nothing ever
    // redacts". `redactUserRequest` sets the marker and flips the flag.
    const server_identity = generateEd25519Keypair('server_identity_key');
    const wrapped = createSigningRecuedPlanStore(makeBaseStore(), {
      getServerIdentity: () => server_identity,
    });
    for (const high_assurance of [false, true]) {
      const plan = buildPlan({
        plan_id: `plan-redact-${String(high_assurance)}`,
        user_request: 'please summarise my inbox',
        audit_policy: {
          retain_for_days: 90,
          high_assurance,
          redact_user_request: true,
        },
      });
      await wrapped.append(plan);
      const got = await wrapped.get(plan.plan_id);
      expect(got?.user_request).toBe(REDACTED_USER_REQUEST_MARKER);
      expect(got?.user_request).not.toContain('inbox');
    }
  });

  it('signs high-assurance plans automatically at append time', async () => {
    const server_identity = generateEd25519Keypair('server_identity_key');
    const wrapped = createSigningRecuedPlanStore(makeBaseStore(), {
      getServerIdentity: () => server_identity,
    });
    const plan = buildPlan({
      audit_policy: {
        retain_for_days: 90,
        high_assurance: true,
        redact_user_request: false,
      },
    });
    await wrapped.append(plan);
    const got = await wrapped.get(plan.plan_id);
    expect(typeof got?.signature).toBe('string');
    expect(got?.signer_fingerprint).toBe(server_identity.public_key_fingerprint);
    // Verify the persisted bytes round-trip clean.
    const result = verifyRecuedPlan(got!, server_identity.public_key_b64);
    expect(result.ok).toBe(true);
  });

  it('redacts user_request BEFORE signing (signature commits to redacted bytes)', async () => {
    const server_identity = generateEd25519Keypair('server_identity_key');
    const wrapped = createSigningRecuedPlanStore(makeBaseStore(), {
      getServerIdentity: () => server_identity,
    });
    const plan = buildPlan({
      user_request: 'sensitive customer data: SSN 123-45-6789',
      audit_policy: {
        retain_for_days: 90,
        high_assurance: true,
        redact_user_request: true,
      },
    });
    await wrapped.append(plan);
    const got = await wrapped.get(plan.plan_id);
    expect(got?.user_request).toBe(REDACTED_USER_REQUEST_MARKER);
    // Signature still verifies — it committed to the redacted bytes.
    const result = verifyRecuedPlan(got!, server_identity.public_key_b64);
    expect(result.ok).toBe(true);
  });

  it('redacts user_request even when high_assurance is false', async () => {
    const server_identity = generateEd25519Keypair('server_identity_key');
    const wrapped = createSigningRecuedPlanStore(makeBaseStore(), {
      getServerIdentity: () => server_identity,
    });
    const plan = buildPlan({
      user_request: 'sensitive customer data',
      audit_policy: {
        retain_for_days: 90,
        high_assurance: false,
        redact_user_request: true,
      },
    });
    await wrapped.append(plan);
    const got = await wrapped.get(plan.plan_id);
    expect(got?.user_request).toBe(REDACTED_USER_REQUEST_MARKER);
    expect(got?.signature).toBeUndefined();
  });

  it('picks up current server identity per call (post-rotation)', async () => {
    const v1 = generateEd25519Keypair('server_identity_key');
    const v2 = generateEd25519Keypair('server_identity_key');
    let current = v1;
    const wrapped = createSigningRecuedPlanStore(makeBaseStore(), {
      getServerIdentity: () => current,
    });
    await wrapped.append(
      buildPlan({
        plan_id: 'plan-pre-rotation',
        audit_policy: {
          retain_for_days: 90,
          high_assurance: true,
          redact_user_request: false,
        },
      }),
    );
    current = v2; // rotate
    await wrapped.append(
      buildPlan({
        plan_id: 'plan-post-rotation',
        audit_policy: {
          retain_for_days: 90,
          high_assurance: true,
          redact_user_request: false,
        },
      }),
    );

    const pre = await wrapped.get('plan-pre-rotation');
    const post = await wrapped.get('plan-post-rotation');
    expect(pre?.signer_fingerprint).toBe(v1.public_key_fingerprint);
    expect(post?.signer_fingerprint).toBe(v2.public_key_fingerprint);

    // Rotation-aware resolver verifies both.
    const resolver = (fp: string): string | null => {
      if (fp === v1.public_key_fingerprint) return v1.public_key_b64;
      if (fp === v2.public_key_fingerprint) return v2.public_key_b64;
      return null;
    };
    expect(verifyRecuedPlan(pre!, resolver).ok).toBe(true);
    expect(verifyRecuedPlan(post!, resolver).ok).toBe(true);
  });

  it('honors a custom shouldSign predicate (force-sign non-high-assurance plans)', async () => {
    // The runtime validator rejects high_assurance:true without
    // signature, so a `shouldSign: () => false` override on such a
    // plan is a user error — covered by the validator gate. The
    // custom predicate's useful direction is the inverse: opt in to
    // signing on plans that didn't request high_assurance.
    const server_identity = generateEd25519Keypair('server_identity_key');
    let signCalled = 0;
    const wrapped = createSigningRecuedPlanStore(makeBaseStore(), {
      getServerIdentity: () => {
        signCalled++;
        return server_identity;
      },
      shouldSign: () => true, // sign every plan regardless of policy
    });
    await wrapped.append(buildPlan()); // high_assurance: false
    expect(signCalled).toBe(1);
    const got = await wrapped.get('plan-001');
    expect(typeof got?.signature).toBe('string');
    expect(got?.signer_fingerprint).toBe(server_identity.public_key_fingerprint);
  });

  it('list / size / delete / clearOlderThan / clearAll pass through', async () => {
    const server_identity = generateEd25519Keypair('server_identity_key');
    const wrapped = createSigningRecuedPlanStore(makeBaseStore(), {
      getServerIdentity: () => server_identity,
    });
    await wrapped.append(buildPlan({ plan_id: 'a', started_at: 100 }));
    await wrapped.append(buildPlan({ plan_id: 'b', started_at: 200 }));
    expect(await wrapped.size()).toBe(2);
    expect((await wrapped.list()).length).toBe(2);
    expect(await wrapped.delete('a')).toBe(true);
    expect(await wrapped.clearOlderThan(300)).toBe(1);
    await wrapped.clearAll();
    expect(await wrapped.size()).toBe(0);
  });
});

/* ─── Mutation sweep of `recued-plan/signing.ts`, 2026-09-18 ────────────────
 *  15 mutations; 13 caught. The redact-before-sign invariant is well pinned —
 *  signing the unredacted plan, skipping redaction, and returning the raw
 *  request beside a redacted signature all red immediately.
 *
 *  EQUIVALENT, both because the redaction is applied at TWO layers on purpose:
 *
 *  1. `signRecuedPlan`'s `user_request !== REDACTED_USER_REQUEST_MARKER`
 *     guard. `redactUserRequest` is IDEMPOTENT — it sets the marker and flips
 *     `audit_policy.redact_user_request` to true, so applying it twice gives
 *     the same plan. The guard is a short-circuit, not a correctness property.
 *
 *  2. The wrapper passing `redacted` rather than `plan` into `signRecuedPlan`.
 *     The primitive redacts internally for exactly this reason — the module
 *     says a direct caller "must not be able to bypass it" — so handing it the
 *     raw plan produces the same signed bytes. That is the defence-in-depth
 *     working; keep both.
 *
 *  ⚠ AND THE TWO LAYERS ARE WHY THE REAL GAP HID. A plan that opts OUT of
 *  redaction is the only fixture where one layer losing its policy check is
 *  visible, because on an opt-IN plan the other layer covers for it.
 * ────────────────────────────────────────────────────────────────────────── */

