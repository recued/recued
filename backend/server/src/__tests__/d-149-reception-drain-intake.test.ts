/** D-149 § A.5.3 + § Must Hold I-12 — intake_form submission drain.
 *
 *  ⚠ D-210 Phase C RE-AIMED THIS SUITE. It used to be the **auto-accept
 *  byte-equivalence** suite: every config set `auto_accept: true` and the
 *  assertions were the exact entity shapes the retired D-149 drain produced.
 *  `auto_accept` is now retired on all three reception kinds (owner ruling,
 *  2026-07-18), so that subject no longer exists — the drain NEVER
 *  materializes, it only dispatches for review.
 *
 *  What survives, and why it is still worth testing HERE (the review path's
 *  own dispatch assertions live in `d-173-reception-drain-single-path.test.ts`):
 *    - the DRAIN-LOOP behaviours, which are orthogonal to what a row becomes:
 *      an already-processed row is not re-drained, a since-disabled endpoint
 *      still drains, a revoked endpoint still drains an accepted submission,
 *      and the per-tick batch budget bounds work.
 *    - FAILURE handling, all of it pre-branch: corrupt config, undecryptable
 *      blob, unavailable PII key, and the work-entity upsert idempotency
 *      substrate.
 *    - the drain BACKBONE: registration shape, fire-immediate, the sync-tick
 *      overlap guard, and the no-processor no-op.
 *
 *  Deleted with their subject: the per-target materialization shape tests
 *  (task / note / commitment / inbox_item projection — the approve-leg
 *  projection owns those now) and the notify + triggered_recipe effect-seam
 *  tests (both seams had zero call sites once the branch went, and were never
 *  production-wired anyway). */

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RECUED_BUILTIN_SOURCE_ID, type IntakeFormConfig } from '@recued/contracts';
import { ensureReceptionSchema } from '../storage/reception-store.js';
import {
  createReceptionFormSubmissionStore,
  type FormSubmissionStore,
} from '../storage/reception-form-store.js';
import {
  createPublicEndpointRegistryStore,
  type PublicEndpointRegistryStore,
} from '../storage/public-endpoint-registry-store.js';
import {
  createWorkEntityStore,
  ensureWorkEntitySchema,
  type WorkEntityStore,
} from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import {
  deriveFormSubmissionPiiKeyFromSubDek,
  sealFormSubmissionField,
} from '../ports/reception/form-pii.js';
import { computeBearerHmac, deriveReceptionPepper } from '../ports/reception/server-secret-pepper.js';
import { createIntakeFormSubmissionProcessor } from '../ports/reception/processors/intake-form-processor.js';
import {
  createReceptionDrainRunner,
  registerReceptionDrain,
  type ReceptionSubmissionProcessor,
} from '../ports/reception/reception-drain.js';
import type {
  BackgroundServiceRegistry,
  StoppableService,
} from '../composition/bin/wire-background-services.js';

const NOW = 1_700_000_000_000;
const PEPPER = deriveReceptionPepper(Buffer.alloc(32, 0xc4));
const FORM_KEY = deriveFormSubmissionPiiKeyFromSubDek(Buffer.alloc(32, 0x5a));

interface Env {
  registry: PublicEndpointRegistryStore;
  formStore: FormSubmissionStore;
  workStore: WorkEntityStore;
}

const buildEnv = (): Env => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  ensureWorkEntitySchema(db);
  const workStore = createWorkEntityStore(db);
  autoRegisterRecuedBuiltinSources(workStore, NOW);
  return {
    registry: createPublicEndpointRegistryStore(db),
    formStore: createReceptionFormSubmissionStore(db),
    workStore,
  };
};

const baseConfig = (over: Partial<IntakeFormConfig['submission_processing_rule']> = {}): IntakeFormConfig => ({
  display_name: 'Mary',
  form_definition: {
    form_definition_id: 'fd_drain',
    fields: [
      { name: 'subject', type: 'text', label: 'Subject', required: true },
      { name: 'details', type: 'textarea', label: 'Details', required: true },
      { name: 'budget', type: 'text', label: 'Budget', required: false },
    ],
  },
  submission_processing_rule: {
    target_kind: 'task',
    fields_to_include_in_target: ['subject', 'details'],
    fields_to_attach_as_metadata: ['budget'],
    ...over,
  },
  anti_spam: { honeypot_fields: [], rate_limit_per_ip: 5, require_proof_of_work: false, require_captcha: false },
  required_visitor_fields: { email: 'optional' },
});

const seedEndpoint = (env: Env, endpoint_id: string, config: IntakeFormConfig, enabled = true): void => {
  env.registry.create({
    endpoint_id,
    kind: 'intake_form',
    packet_declaration: {
      packet_kind: 'intake_form_packet',
      source_query_ref: { kind: 'reception_form_definition', form_definition_id: config.form_definition.form_definition_id },
    },
    bearer_secret_hmac: computeBearerHmac('tok', PEPPER),
    created_at: NOW - 1000,
    created_by_client_id: 'inst-1',
    expires_at: null,
    long_lived_acknowledged_at: NOW - 1000,
    metadata: config as unknown as Record<string, unknown>,
  });
  if (enabled) env.registry.enable(endpoint_id, NOW);
};

const seedSubmission = async (
  env: Env,
  input: { endpoint_id: string; submission_id: string; fields: Record<string, unknown>; visitor_email?: string },
): Promise<void> => {
  const blobJson = JSON.stringify({
    ...(input.visitor_email ? { visitor_email: input.visitor_email } : {}),
    fields: input.fields,
  });
  const submission_blob_encrypted = await sealFormSubmissionField({
    key: FORM_KEY,
    endpoint_id: input.endpoint_id,
    submission_id: input.submission_id,
    field: 'submission_blob',
    plaintext: blobJson,
  });
  env.formStore.insert({
    submission_id: input.submission_id,
    endpoint_id: input.endpoint_id,
    form_definition_id: 'fd_drain',
    submitted_at: NOW - 500,
    source_ip_hash: null,
    visitor_email_encrypted: null,
    submission_blob_encrypted: submission_blob_encrypted!,
    schema_version: 1,
    processing_outcome: 'pending',
  });
};

/** D-210 Phase C — review is the ONLY path, so the dispatch seam has to be
 *  wired or every row stays PENDING and the drain-loop assertions below would
 *  pass vacuously. Records what it was handed so a test can assert dispatch. */
const processorFor = (
  env: Env,
  extra: Partial<Parameters<typeof createIntakeFormSubmissionProcessor>[0]> = {},
): ReceptionSubmissionProcessor =>
  createIntakeFormSubmissionProcessor({
    registryStore: env.registry,
    submissionStore: env.formStore,
    workEntityStore: env.workStore,
    getFormSubmissionPiiKey: () => FORM_KEY,
    now: () => NOW,
    fireReceptionWorkflow: async () => ({ dispatched: true }),
    ...extra,
  });

describe('intake_form drain — dispatch + drain-loop', () => {
  // D-210 Phase C — the per-target MATERIALIZATION tests that lived here
  // (task / note / commitment / inbox_item shape projection) went with the
  // auto-accept branch: the drain no longer writes an entity at all. Their
  // subject moved to the approve-leg projection, which owns those shapes.
  // What remains are the drain-LOOP behaviours, which never depended on what
  // a row becomes.

  let env: Env;
  beforeEach(() => {
    env = buildEnv();
  });

  it('does not re-process an already-processed submission', async () => {
    seedEndpoint(env, 'ep-task', baseConfig());
    await seedSubmission(env, { endpoint_id: 'ep-task', submission_id: 'sub-1', fields: { subject: 's', details: 'd' } });
    const first = await processorFor(env).drainOnce({ now: NOW, limit: 50 });
    expect(first.processed).toBe(1);
    const second = await processorFor(env).drainOnce({ now: NOW, limit: 50 });
    expect(second).toEqual({ processed: 0, failed: 0 });
  });

  it('still drains a since-disabled (non-revoked) endpoint', async () => {
    seedEndpoint(env, 'ep-task', baseConfig(), false); // created, never enabled
    await seedSubmission(env, { endpoint_id: 'ep-task', submission_id: 'sub-d', fields: { subject: 's', details: 'd' } });
    const res = await processorFor(env).drainOnce({ now: NOW, limit: 50 });
    expect(res.processed).toBe(1);
  });

  it('still drains an already-accepted submission after the endpoint is revoked', async () => {
    seedEndpoint(env, 'ep-task', baseConfig());
    await seedSubmission(env, { endpoint_id: 'ep-task', submission_id: 'sub-rev', fields: { subject: 's', details: 'd' } });
    // Endpoint revoked AFTER the submission was accepted but BEFORE the drain.
    env.registry.revoke({ endpoint_id: 'ep-task', now: NOW, reason: 'revoked by operator' });
    const res = await processorFor(env).drainOnce({ now: NOW, limit: 50 });
    expect(res.processed).toBe(1);
    expect(env.formStore.findById('sub-rev')!.processing_outcome).toBe('processed');
  });

  it('bounds work to the per-tick batch limit', async () => {
    seedEndpoint(env, 'ep-task', baseConfig());
    for (let i = 0; i < 3; i++) {
      await seedSubmission(env, { endpoint_id: 'ep-task', submission_id: `sub-${i}`, fields: { subject: `s${i}`, details: 'd' } });
    }
    const res = await processorFor(env).drainOnce({ now: NOW, limit: 2 });
    expect(res.processed).toBe(2);
    // the remaining one drains on the next tick
    const res2 = await processorFor(env).drainOnce({ now: NOW, limit: 2 });
    expect(res2.processed).toBe(1);
  });
});

describe('intake_form drain — failure handling', () => {
  it('fails a submission whose endpoint config is corrupt (row retained, no entity)', async () => {
    const env = buildEnv();
    // Seed a registry row whose metadata is NOT a valid IntakeFormConfig.
    env.registry.create({
      endpoint_id: 'ep-bad',
      kind: 'intake_form',
      packet_declaration: { packet_kind: 'intake_form_packet', source_query_ref: { kind: 'reception_form_definition', form_definition_id: 'x' } },
      bearer_secret_hmac: computeBearerHmac('tok', PEPPER),
      created_at: NOW - 1000,
      created_by_client_id: 'inst-1',
      expires_at: null,
      long_lived_acknowledged_at: NOW - 1000,
      metadata: { not_a_config: true },
    });
    env.registry.enable('ep-bad', NOW);
    await seedSubmission(env, { endpoint_id: 'ep-bad', submission_id: 'sub-bad', fields: { subject: 's', details: 'd' } });

    const res = await processorFor(env).drainOnce({ now: NOW, limit: 50 });
    expect(res).toEqual({ processed: 0, failed: 1 });
    expect(env.formStore.findById('sub-bad')!.processing_outcome).toBe('failed');
  });

  it('fails a submission whose blob cannot be decrypted (wrong key)', async () => {
    const env = buildEnv();
    seedEndpoint(env, 'ep-task', baseConfig());
    await seedSubmission(env, { endpoint_id: 'ep-task', submission_id: 'sub-x', fields: { subject: 's', details: 'd' } });
    // Processor uses a DIFFERENT key than the one the blob was sealed with.
    const wrongKey = deriveFormSubmissionPiiKeyFromSubDek(Buffer.alloc(32, 0x99));
    const res = await processorFor(env, { getFormSubmissionPiiKey: () => wrongKey }).drainOnce({ now: NOW, limit: 50 });
    expect(res).toEqual({ processed: 0, failed: 1 });
    expect(env.formStore.findById('sub-x')!.processing_outcome).toBe('failed');
  });

  it('leaves submissions PENDING (not failed) when the PII key is unavailable', async () => {
    const env = buildEnv();
    seedEndpoint(env, 'ep-task', baseConfig());
    await seedSubmission(env, { endpoint_id: 'ep-task', submission_id: 'sub-locked', fields: { subject: 's', details: 'd' } });
    // Simulate a locked vault — the key getter throws (as the real
    // derivation does under FileVault lock). The tick must abort, not mark
    // the row failed, so it retries after unlock.
    const res = await processorFor(env, {
      getFormSubmissionPiiKey: () => {
        throw new Error('vault locked');
      },
    }).drainOnce({ now: NOW, limit: 50 });
    expect(res).toEqual({ processed: 0, failed: 0 });
    expect(env.formStore.findById('sub-locked')!.processing_outcome).toBe('pending');
  });

  it('work-entity write upserts on a repeated reception id (idempotency substrate)', () => {
    const env = buildEnv();
    const id = 'reception_dup';
    env.workStore.writeTask({ id, title: 'first', source_id: RECUED_BUILTIN_SOURCE_ID('task') }, NOW);
    env.workStore.writeTask({ id, title: 'second', source_id: RECUED_BUILTIN_SOURCE_ID('task') }, NOW);
    expect(env.workStore.listTasks().filter((t) => t.id === id)).toHaveLength(1);
    expect(env.workStore.readTask(id)!.title).toBe('second');
  });
});

// ────────────────────────────────────────────────────────────────
// Drain backbone
// ────────────────────────────────────────────────────────────────

const fakeBackgroundServices = () => {
  const services: StoppableService[] = [];
  const registry: BackgroundServiceRegistry & { services: StoppableService[] } = {
    register: (s) => {
      services.push(s);
    },
    registerInterval: () => () => {},
    stopAll: async () => {},
    list: () => [],
    services,
  };
  return registry;
};

describe('reception drain runner', () => {
  it('ticks the processors once per pass', async () => {
    const drainOnce = vi.fn(async () => ({ processed: 0, failed: 0 }));
    const runner = createReceptionDrainRunner({ processors: [{ label: 't', drainOnce }], now: () => NOW });
    runner.tick();
    await runner.stop();
    expect(drainOnce).toHaveBeenCalledTimes(1);
  });

  it('does not re-enter a still-running drain (overlap guard)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const drainOnce = vi.fn(async () => {
      await gate;
      return { processed: 0, failed: 0 };
    });
    const runner = createReceptionDrainRunner({ processors: [{ label: 't', drainOnce }], now: () => NOW });
    runner.tick();
    runner.tick(); // skipped — first pass still in-flight
    expect(drainOnce).toHaveBeenCalledTimes(1);
    release();
    await runner.stop();
    runner.tick(); // stopped → no-op
    expect(drainOnce).toHaveBeenCalledTimes(1);
  });

  it('stop() does not resolve until the in-flight drain settles', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let finished = false;
    const drainOnce = vi.fn(async () => {
      await gate;
      finished = true;
      return { processed: 0, failed: 0 };
    });
    const runner = createReceptionDrainRunner({ processors: [{ label: 't', drainOnce }], now: () => NOW });
    runner.tick();
    const stopP = runner.stop();
    expect(finished).toBe(false); // drain still gated
    release();
    await stopP;
    expect(finished).toBe(true); // stop awaited the drain to completion
  });
});

describe('registerReceptionDrain', () => {
  it('registers a stoppable reception-drain timer and sweeps once immediately', async () => {
    const bg = fakeBackgroundServices();
    const drainOnce = vi.fn(async () => ({ processed: 0, failed: 0 }));
    registerReceptionDrain({
      backgroundServices: bg,
      processors: [{ label: 't', drainOnce }],
      now: () => NOW,
      intervalMs: 1_000_000, // long — only the fire-immediate sweep runs during the test
    });
    expect(bg.services).toHaveLength(1);
    expect(bg.services[0]!.name).toBe('reception-drain');
    expect(bg.services[0]!.kind).toBe('timer');
    expect(drainOnce).toHaveBeenCalledTimes(1); // boot sweep
    // stop clears the real interval (no leaked handle) + resolves.
    await bg.services[0]!.stop();
  });

  it('registers nothing when there are no processors', () => {
    const bg = fakeBackgroundServices();
    registerReceptionDrain({ backgroundServices: bg, processors: [], now: () => NOW });
    expect(bg.services).toHaveLength(0);
  });
});
