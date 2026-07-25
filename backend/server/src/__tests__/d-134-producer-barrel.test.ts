/** D-134 Phase 2 — declarative registration tables.
 *
 *  These tests guard the substrate against drift between producer
 *  files on disk and the registration tables in
 *  `housekeeping/registration.ts`. A producer file landing without a
 *  table entry would silently regress (no scheduler registration), so
 *  the directory walk + cross-check is the safety net.
 *
 *  Spec: D-134 §A.3 / §A.4. */

import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  STANDALONE_TASKS,
  PER_RECORD_PRODUCERS,
  type PerRecordWalkerKind,
} from '../housekeeping/registration.js';
import {
  ENRICHMENT_REGISTRY,
  isEnrichmentTopic,
} from '@recued/contracts';
import { isTypeScriptSource } from '../../../../test/source-file-extensions.js';

const PRODUCERS_DIR = join(__dirname, '..', 'housekeeping', 'producers');
const TASKS_DIR = join(__dirname, '..', 'housekeeping', 'tasks');

const listSourceFiles = (dir: string): string[] =>
  readdirSync(dir).filter((f) => isTypeScriptSource(f) && !f.endsWith('.test.ts') && !f.startsWith('_'));

describe('D-134 P2 — STANDALONE_TASKS', () => {
  it('contains both core tasks and standalone enrichment tasks', () => {
    expect(STANDALONE_TASKS.length).toBeGreaterThan(0);
    const ids = STANDALONE_TASKS.map((t) => t.meta.id);
    expect(ids).toContain('audit-compaction');
    expect(ids).toContain('cache-eviction-beyond-ttl');
    expect(ids).toContain('link-discovery');
    expect(ids).toContain('deterministic-risk-patterns');
    expect(ids).toContain('enrichment.confidence_drift_signal');
    expect(ids).toContain('enrichment.topic_cluster');
  });

  it('every task has a unique id', () => {
    const ids = STANDALONE_TASKS.map((t) => t.meta.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('core tasks declare meta.kind = "core"', () => {
    const coreIds = ['audit-compaction', 'cache-eviction-beyond-ttl', 'link-discovery', 'deterministic-risk-patterns'];
    for (const id of coreIds) {
      const t = STANDALONE_TASKS.find((t) => t.meta.id === id);
      expect(t).toBeDefined();
      expect(t!.meta.kind).toBe('core');
    }
  });

  it('enrichment tasks declare meta.kind = "enrichment"', () => {
    const enrichmentIds = STANDALONE_TASKS
      .filter((t) => t.meta.id.startsWith('enrichment.'))
      .map((t) => t.meta.id);
    expect(enrichmentIds.length).toBeGreaterThan(0);
    for (const id of enrichmentIds) {
      const t = STANDALONE_TASKS.find((t) => t.meta.id === id);
      expect(t!.meta.kind).toBe('enrichment');
    }
  });
});

describe('D-134 P2 — PER_RECORD_PRODUCERS', () => {
  it('contains 30 entries spanning 8 walker kinds', () => {
    expect(PER_RECORD_PRODUCERS.length).toBe(30);
    const kinds = new Set(PER_RECORD_PRODUCERS.map((e) => e.walker_kind));
    expect(kinds).toEqual(
      new Set<PerRecordWalkerKind>([
        'mail-thread',
        'mail-body',
        'contact',
        'calendar',
        'file',
        'note',
        'task',
        'project',
      ]),
    );
  });

  it('every producer references a registered enrichment topic', () => {
    for (const { producer } of PER_RECORD_PRODUCERS) {
      expect(isEnrichmentTopic(producer.topic)).toBe(true);
      expect(ENRICHMENT_REGISTRY[producer.topic]).toBeDefined();
    }
  });

  /** D-145 PA9 multi-scope task-id substrate — `open_loop_pressure`
   *  legitimately ships per-contact AND per-project producers, so the
   *  "unique topic" invariant relaxes to "unique (topic,
   *  source_scope)". A topic with multiple producers MUST disambiguate
   *  via `task_id_suffix` so their `housekeeping_state` row keys
   *  diverge. */
  it('every producer has a unique (topic, source_scope) pair', () => {
    const keys = PER_RECORD_PRODUCERS.map((e) => `${e.producer.topic}|${e.producer.source_scope}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('multi-scope topics declare task_id_suffix on all-but-one entry to avoid task-id collision', () => {
    const byTopic = new Map<string, typeof PER_RECORD_PRODUCERS>();
    for (const entry of PER_RECORD_PRODUCERS) {
      const list = (byTopic.get(entry.producer.topic) ?? []) as typeof PER_RECORD_PRODUCERS;
      byTopic.set(entry.producer.topic, [...list, entry]);
    }
    for (const [topic, entries] of byTopic) {
      if (entries.length === 1) continue;
      const taskIds = entries.map((e) =>
        e.task_id_suffix !== undefined
          ? `enrichment.${topic}.${e.task_id_suffix}`
          : `enrichment.${topic}`,
      );
      expect(new Set(taskIds).size).toBe(taskIds.length);
    }
  });

  it('mail-thread bucket holds body-blind walker users (thread_signals + task_signal_density_per_thread)', () => {
    const threadEntries = PER_RECORD_PRODUCERS.filter((e) => e.walker_kind === 'mail-thread');
    const topics = threadEntries.map((e) => e.producer.topic).sort();
    expect(topics).toEqual(['task_signal_density_per_thread', 'thread_signals']);
  });

  it('mail-body bucket holds the body-aware walker users', () => {
    const bodyEntries = PER_RECORD_PRODUCERS.filter((e) => e.walker_kind === 'mail-body');
    const topics = bodyEntries.map((e) => e.producer.topic).sort();
    expect(topics).toEqual(['action_items', 'embedding', 'purpose', 'summary']);
  });

  it('contact bucket holds contact-scope producers', () => {
    const contactEntries = PER_RECORD_PRODUCERS.filter((e) => e.walker_kind === 'contact');
    const topics = contactEntries.map((e) => e.producer.topic).sort();
    expect(topics).toEqual([
      'attendee_patterns',
      'behavioral_signature',
      'commitment_followthrough_score',
      'commitment_imbalance',
      'commitment_reliability_band',
      'company',
      'meeting_frequency',
      'open_loop_pressure',
      'outbound_commitment_overdue_count',
      'preferred_channel_by_contact',
      'reply_patterns',
      'role',
      'task_completion_velocity',
    ]);
  });

  it('calendar bucket holds calendar-scope producers', () => {
    const calendarEntries = PER_RECORD_PRODUCERS.filter((e) => e.walker_kind === 'calendar');
    const topics = calendarEntries.map((e) => e.producer.topic).sort();
    expect(topics).toEqual(['preparation_notes', 'related_threads']);
  });

  it('file bucket holds file-scope media enrichment producers', () => {
    const fileEntries = PER_RECORD_PRODUCERS.filter((e) => e.walker_kind === 'file');
    const topics = fileEntries.map((e) => e.producer.topic).sort();
    expect(topics).toEqual(['caption', 'extracted_text', 'transcript']);
  });

  it('note bucket holds note-scope producers (D-145 PA9 novel walker)', () => {
    const noteEntries = PER_RECORD_PRODUCERS.filter((e) => e.walker_kind === 'note');
    const topics = noteEntries.map((e) => e.producer.topic).sort();
    expect(topics).toEqual(['note_relevance_decay']);
  });

  it('task bucket holds task-scope producers (D-145 PA9 novel walker)', () => {
    const taskEntries = PER_RECORD_PRODUCERS.filter((e) => e.walker_kind === 'task');
    const topics = taskEntries.map((e) => e.producer.topic).sort();
    expect(topics).toEqual(['task_duplicate_candidate']);
  });

  it('project bucket holds project-scope producers (D-145 PA9 novel walker)', () => {
    const projectEntries = PER_RECORD_PRODUCERS.filter((e) => e.walker_kind === 'project');
    const topics = projectEntries.map((e) => e.producer.topic).sort();
    // `open_loop_pressure` appears here as the dual-scope companion to
    // the per-contact entry above — the contact entry stays unsuffixed
    // (back-compat with the legacy `enrichment.open_loop_pressure` task
    // id); the project entry composes `enrichment.open_loop_pressure.project`.
    expect(topics).toEqual([
      'open_loop_pressure',
      'project_next_action_gap',
      'project_stall_signal',
      'project_velocity',
    ]);
  });
});

describe('D-134 P2 — barrel completeness', () => {
  /** Catches a producer file landing without a registration entry. The
   *  walk filters `_*.ts` shared helpers (which intentionally aren't
   *  registrable). Test files are filtered by extension. */
  it('every producer file in producers/ appears in either standalone or per-record arrays', () => {
    const files = listSourceFiles(PRODUCERS_DIR).map((f) => f.replace(/\.ts$/, ''));
    const registeredCandidates = new Set<string>([
      // standalone enrichment task ids minus the `enrichment.` prefix
      ...STANDALONE_TASKS
        .filter((t) => t.meta.id.startsWith('enrichment.'))
        .map((t) => t.meta.id.slice('enrichment.'.length)),
      // per-record producer topics
      ...PER_RECORD_PRODUCERS.map((e) => e.producer.topic),
      // D-145 PA9 multi-scope task-id substrate — entries with a
      // `task_id_suffix` ship a per-scope file (e.g.
      // `open-loop-pressure-project.ts`). Register
      // `${topic}_${task_id_suffix}` so the snake_case filename
      // normalisation below resolves to a known variant.
      ...PER_RECORD_PRODUCERS
        .filter((e) => e.task_id_suffix !== undefined)
        .map((e) => `${e.producer.topic}_${e.task_id_suffix}`),
    ]);

    // Producer filenames may use either snake_case (e.g. `topic_cluster`)
    // or kebab-case (`thread-signals`); the registered topic is always
    // snake_case. Normalise filenames to topic shape before comparison.
    const fileTopicCandidates = files.map((f) => f.replace(/-/g, '_'));

    const missing: string[] = [];
    for (const candidate of fileTopicCandidates) {
      if (!registeredCandidates.has(candidate)) {
        missing.push(candidate);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every core task file in tasks/ appears in STANDALONE_TASKS', () => {
    const files = listSourceFiles(TASKS_DIR).map((f) => f.replace(/\.ts$/, ''));
    const registeredCoreIds = new Set<string>(
      STANDALONE_TASKS
        .filter((t) => t.meta.kind === 'core')
        .map((t) => t.meta.id),
    );

    // Dep-injected tasks live under `tasks/` but ship as builder
    // functions (not static instances) because they require runtime
    // deps the registration tables can't carry — `bin.ts` registers
    // them after the dep is constructed. Each entry must match the
    // builder's task id so a task-id rename trips the ratchet.
    const DEP_INJECTED_TASK_IDS = new Set<string>([
      // D-138 P3 — needs `ContactStore` + the realtime event bus.
      'contact-merge-candidate-scan',
      // D-145 PA4 — needs `WorkEntityStore` + warehouse bus +
      // (optional) cascade engine. Builder ships as
      // `buildWorkEntityDueStatusSweepTask`.
      'work-entity-due-status-sweep',
      // D-148 § A.6.5 — needs `RotationEngine` + `PairBlobCertSource`.
      // Builder ships as `buildTlsCertRenewalTask`; gated in bin.ts on
      // both deps being present. Cert source + production `TlsRenewalHook`
      // adapter (`createDomainBackedTlsRenewalHook`) both wired post-
      // 94th cert-source/renewal-hook slice — `RotationEngineOptions.tls`
      // is populated end-to-end. The renewer the hook delegates to is
      // still `null`, so the engine returns `acme_helper_unavailable`
      // until the production ACME composition lands.
      'tls-cert-renewal',
      // D-177 N.13 P6b — needs the contract substrate (definition +
      // suggestion stores over `ContractStore`) + the realtime event bus.
      // Builder ships as `buildDelegationRuleSuggestionScanTask`; gated in
      // the housekeeping composer on `contractStore` being composed.
      'delegation-rule-suggestion-scan',
      // D-202 Slice 1 — the reject-driven quality learner. Builder ships as
      // `buildQualityDelegationSuggestionScanTask`; gated in the housekeeping
      // composer on `contractStore` (wire-housekeeping-substrate.ts:606).
      'quality-delegation-suggestion-scan',
      // D-172 resumable uploads — the TTL/orphan session reaper. Builder ships
      // as `buildUploadSweepTask`; gated on `uploadService` (db + CAS)
      // (wire-housekeeping-substrate.ts:688).
      'upload-sweep',
      // M4b.1 — reaps archive-upload sessions/scratch + prunes staged archives
      // past their TTL. Builder ships as `buildArchiveUploadSweepTask`; gated
      // on `archiveUploadService` (wire-housekeeping-substrate.ts:700).
      'archive-upload-sweep',
      // D-196 §6.3 — the seller entitlement reconciler. Builder ships as
      // `buildSellerAccessReconcileTask`; gated on `sellerAccessReconcileDeps`
      // (wire-housekeeping-substrate.ts:676).
      'seller-access-reconcile',
    ]);

    const missing: string[] = [];
    for (const file of files) {
      if (registeredCoreIds.has(file)) continue;
      if (DEP_INJECTED_TASK_IDS.has(file)) continue;
      missing.push(file);
    }
    expect(missing).toEqual([]);
  });
});
