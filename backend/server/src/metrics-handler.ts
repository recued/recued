/** D-250 § D7 — `metric.read`: the owner's own numbers, over the pair rpc.
 *
 *  ⛔ READ-ONLY AND LOCAL-ONLY. § D4 splits the acts: computing is housekeeping's job and
 *  needs no authorization; PUBLISHING is a separate outward act carrying its own bounded,
 *  revocable grant. Nothing here reaches the network, and a publish must never be folded
 *  into this method just because it is where the numbers already are.
 *
 *  🔑 BOTH STORES ARE RETURNED BECAUSE THEY ANSWER DIFFERENT QUESTIONS, and flattening
 *  them into one list would lose the distinction that matters: the snapshot is RECOMPUTED
 *  and replaced whole (so it can go down, and it holds nothing older than the audit
 *  window), while an artifact ADVANCES from its own prior value (so a record survives a
 *  quiet week). A UI that rendered them identically would eventually explain a dropped
 *  record as a bug.
 */

import type Database from 'better-sqlite3';
import {
  METRIC_REGISTRY,
  MILESTONE_REGISTRY,
  type MetricReadEntry,
  type MetricPublicationEntry,
  type MetricReadOutput,
  type MetricSubmitSkipReason,
} from '@recued/contracts';

import { createMetricArtifactStore } from './metrics/artifact-store.js';
import { createBoardPublicationStore } from './metrics/publication-store.js';
import { submitBoards, type BoardSubmitterDeps } from './metrics/board-submitter.js';
import { createMetricSnapshotStore } from './metrics/snapshot-store.js';

export interface MetricRpcDeps {
  db: Database.Database;
  now?: () => number;
  /** § B3.3 — everything the daily batch needs that this module cannot derive: the
   *  signing identity, the cloud-facing publisher_id/handle, the endpoint, and the POST.
   *  ⚠ ABSENT ON A SERVER THAT CANNOT PUBLISH (no bound account, no identity key), and
   *  `metric.submit` then reports `sent: false` rather than throwing — not publishing is
   *  the default state, not a fault. */
  submitter?: () => Omit<BoardSubmitterDeps, 'publications' | 'snapshot' | 'now'> | undefined;
}

export const handleMetricRead = async (deps: MetricRpcDeps): Promise<MetricReadOutput> => {
  const snapshotRow = createMetricSnapshotStore(deps.db).read();
  const artifact = createMetricArtifactStore(deps.db);

  const metrics: MetricReadEntry[] = [];
  for (const m of snapshotRow?.metrics ?? []) {
    const def = METRIC_REGISTRY[m.metric_id];
    // ⛔ A METRIC THE REGISTRY NO LONGER KNOWS IS DROPPED, NOT RENDERED BLANK. A stored
    // snapshot outlives a release that retires a metric, and a row with no label or
    // direction cannot be displayed honestly — "higher is better" is not a safe default.
    if (def === undefined) continue;
    metrics.push({
      metric_id: m.metric_id,
      // ⚠ THE SNAPSHOT'S version, not the registry's. They differ exactly when a release
      // changed a definition and no cycle has recomputed yet, and the number on screen
      // was produced by the OLD one (§ D3.1a).
      metric_version: m.metric_version,
      reading: m.reading,
      label: def.label,
      description: def.description,
      shape: def.shape,
      direction: def.direction,
      publishable: def.publishable,
      // ⚠ LOCAL ONLY (§ D2). The pair rpc is local; the submission path drops these.
      ...(m.numerator !== undefined ? { numerator: m.numerator } : {}),
      ...(m.denominator !== undefined ? { denominator: m.denominator } : {}),
    });
  }

  const earned = new Map<string, number>();
  for (const e of artifact.entries()) {
    if (e.kind === 'once') earned.set(e.key, e.value);
  }

  return {
    snapshot:
      snapshotRow === undefined
        ? null
        : {
            computed_at: snapshotRow.computed_at,
            window: snapshotRow.window,
            metrics,
            ...(snapshotRow.diagnostics ? { diagnostics: snapshotRow.diagnostics } : {}),
          },
    // Records and counters only — milestones are projected separately below so an
    // unearned one still appears.
    artifacts: artifact.entries().filter((e) => e.kind !== 'once'),
    // § D4 — what this server opted into publishing. Empty is the default AND the
    // normal state: computing is automatic, publishing never is.
    publications: createBoardPublicationStore(deps.db).list().map((p) => ({
      tag: p.tag,
      metric_id: p.metric_id,
      season_id: p.season_id,
      state: p.state,
      granted_at: p.granted_at,
    })),
    // ⛔ EVERY REGISTERED MILESTONE IS LISTED, EARNED OR NOT, with `detectable` saying
    // whether this build can even award it. Listing only the earned ones would make an
    // undetectable milestone indistinguishable from one the owner has not reached —
    // "you have not done this" when the truth is "we are not looking".
    milestones: Object.values(MILESTONE_REGISTRY).map((def) => ({
      milestone_id: def.milestone_id,
      label: def.label,
      description: def.description,
      earned_at: earned.get(def.milestone_id) ?? null,
      detectable: def.source === 'audit_window',
    })),
  };
};

/** § D4 — the owner's explicit opt-in. ⛔ THE ONLY THING THAT MAKES PUBLISHING LEGITIMATE:
 *  "the legitimacy comes from the owner's act, not from which bus it rides". A metric that
 *  is NOT publishable (§ D2 — a count publishes VOLUME, a ratio publishes SKILL) is
 *  refused HERE rather than hidden at render time, because a UI is not an enforcement
 *  point. */
export const handleMetricPublish = async (
  deps: MetricRpcDeps,
  args: { tag: string; metric_id: string; season_id: string },
): Promise<{ ok: true; publication: MetricPublicationEntry }> => {
  const def = METRIC_REGISTRY[args.metric_id];
  if (def === undefined) throw new Error(`unknown metric '${args.metric_id}'`);
  if (!def.publishable) {
    throw new Error(`metric '${args.metric_id}' is not publishable (D-250 § D2)`);
  }
  if (args.tag.length === 0 || args.season_id.length === 0) {
    throw new Error('tag and season_id are required');
  }
  const now = deps.now?.() ?? Date.now();
  const p = createBoardPublicationStore(deps.db).grant(args, now);
  return { ok: true, publication: {
    tag: p.tag, metric_id: p.metric_id, season_id: p.season_id,
    state: p.state, granted_at: p.granted_at,
  } };
};

/** § C4 — revoke. ⛔ MOVES TO `withdrawing`, NEVER DELETES: a plain delete is re-created
 *  by tomorrow's batch (§ B3.3's "always send") and the owner silently reappears on a
 *  board they left. Returns null when the tag was never published — revoking nothing is
 *  not an error, but it must not invent a withdrawal for a board never joined. */
export const handleMetricUnpublish = async (
  deps: MetricRpcDeps,
  args: { tag: string },
): Promise<{ ok: true; publication: MetricPublicationEntry | null }> => {
  const now = deps.now?.() ?? Date.now();
  const p = createBoardPublicationStore(deps.db).revoke(args.tag, now);
  return { ok: true, publication: p === undefined ? null : {
    tag: p.tag, metric_id: p.metric_id, season_id: p.season_id,
    state: p.state, granted_at: p.granted_at,
  } };
};

/** § B3.3 — send the batch. ⛔ EXPLICIT, NEVER HOUSEKEEPING (§ D4): computing rides the
 *  maintenance exemption, publishing carries the owner's own act. */
export const handleMetricSubmit = async (
  deps: MetricRpcDeps,
): Promise<{
  ok: true;
  sent: boolean;
  /** ⛔ PRESENT IFF `sent` IS FALSE — see `MetricSubmitSkipReason`. Three of its five
   *  values describe a correctly-working server that has not opted in; one is a fault.
   *  Without it the surface can only say "nothing happened", which is what it said. */
  skip_reason?: MetricSubmitSkipReason;
  results: ReadonlyArray<{
    kind: string; board_id: string; rank?: number; participants?: number; reason?: string;
  }>;
}> => {
  const wiring = deps.submitter?.();
  // ⚠ A server with no publishing identity reports not-sent. Throwing would make "I have
  // not set this up" indistinguishable from "the send failed".
  if (wiring === undefined) {
    return { ok: true, sent: false, results: [], skip_reason: 'no_identity' };
  }
  const res = await submitBoards({
    ...wiring,
    publications: createBoardPublicationStore(deps.db),
    snapshot: createMetricSnapshotStore(deps.db),
    now: deps.now ?? (() => Date.now()),
  });
  return res.sent
    ? { ok: true, sent: true, results: res.results }
    : { ok: true, sent: false, results: res.results, skip_reason: res.reason };
};

export const makeMetricHandlers = (deps: MetricRpcDeps | undefined) => {
  if (!deps) return undefined;
  return {
    methods: ['metric.read', 'metric.publish', 'metric.unpublish', 'metric.submit'] as const,
    handlers: {
      'metric.read': async () => handleMetricRead(deps),
      'metric.publish': async (args: unknown) =>
        handleMetricPublish(deps, args as Parameters<typeof handleMetricPublish>[1]),
      'metric.unpublish': async (args: unknown) =>
        handleMetricUnpublish(deps, args as Parameters<typeof handleMetricUnpublish>[1]),
      'metric.submit': async () => handleMetricSubmit(deps),
    },
  };
};
