/** D-225 § 11 — `mcp-tools-drift-probe`: what actually triggers a re-mint.
 *
 *  D-225 Slice 2 built drift DISPLAY and left drift DETECTION open. § 11 named
 *  it as the thing blocking the enrollment wiring, and the gap is precise:
 *
 *    `handleMcpPackStatus` runs with NO probe — deliberately, so a connections
 *    list can badge every row without touching the network. Its current side is
 *    `ConnectionHealth.tool_hashes`, "persisted at the last probe". But
 *    `handleConnectionProbe` has no scheduled caller. It runs on enrollment, on
 *    `mcpPackPreview`, and when the owner explicitly asks — and nowhere else.
 *
 *  So the badge could only ever report what was true the last time the owner
 *  did something. A connection probed once at enrollment reads `current`
 *  forever, however far the third party has moved. **The badge was a display of
 *  drift, not a detector of it**, and the owner had to already suspect a change
 *  to discover one.
 *
 *  🔑 Borrowing §6.3's framing from `seller-access-reconcile`, which had the
 *  same shape (an accelerator shipped, the authority missing): **the idle probe
 *  is the AUTHORITY; the owner's manual probe is the accelerator.**
 *
 *  ── This does NOT auto-update, and that is the point ──────────────────────
 *  The owner ruled: not auto-install, not auto-update. This task honours that
 *  exactly. It refreshes only the CURRENT side — the third party's tool hashes
 *  as they are right now — so `handleMcpPackStatus` can tell `drifted` from
 *  `current` truthfully. Nothing is minted, nothing is installed, no ruling
 *  moves. The re-mint still runs through the owner's review → commit chain,
 *  which is where `confirm_risk_downgrade` and the disclosure screen live.
 *
 *  ⛔ It is worth being exact about why that separation matters, because a
 *  "just refresh it too" instinct would collapse it: auto-applying a re-mint
 *  would hand a third party the ability to change what it may do on the owner's
 *  server by editing its own `tools/list`. The probe writes a HASH; only the
 *  owner writes a GRANT.
 *
 *  ── What it walks ─────────────────────────────────────────────────────────
 *  Only mcp connections that HAVE an installed generated pack. A connection
 *  without one has nothing to drift FROM — its badge reads `no_pack` and offers
 *  to generate, a state no probe improves. Probing it would be outbound traffic
 *  in support of no decision.
 *
 *  ⚠ Known limits of v1, named rather than implied:
 *
 *  1. NOT interruptible, following `seller-access-reconcile`: `step()` runs one
 *     sweep and keeps no partial cursor, so a small remaining budget would
 *     start work it cannot resume. The set is an owner's own mcp connections —
 *     small — but each entry is a network round trip, so this is a real bound
 *     rather than a free one. If a host ever accumulates enough mcp connections
 *     that one sweep overruns a cycle, this needs a cursor over connection
 *     names, not a bigger budget.
 *  2. NO BACKOFF. A dead endpoint is re-probed every idle cycle. The probe
 *     records its own failure in health and the sweep survives it (per-row
 *     catch), so the cost is outbound noise, not incorrectness — but a host
 *     with a permanently dead mcp connection will keep knocking. Skipping rows
 *     whose last probe errored recently is the obvious v2 and is deliberately
 *     not smuggled in here, because "recently" is a policy number and this
 *     module should not be the first place it gets invented.
 */

import type {
  ConnectionKind,
  HousekeepingCursor,
  HousekeepingStepResult,
} from '@recued/contracts';

import type { HousekeepingContext, HousekeepingTaskInstance } from '../registry.js';

export const MCP_TOOLS_DRIFT_PROBE_TASK_ID = 'mcp-tools-drift-probe';

/** The narrow surface this task needs.
 *
 *  🔑 Deliberately not `ConnectionRpcDeps`. This task's whole job is to cause a
 *  real probe against a real endpoint; a dependency wide enough to stub the
 *  probe would let a test certify a sweep that never touched the network — the
 *  failure this module exists to end. Wiring passes the REAL
 *  `handleConnectionProbe` and the REAL store.
 */
export interface McpToolsDriftProbeDeps {
  /** Every enrolled connection of a kind. */
  listConnections(query: { kind: ConnectionKind }): readonly { name: string }[];
  /** The installed generated pack for a connection, or null when there is none.
   *  Returning null is what skips a connection — see the header on why a
   *  pack-less connection is not probed. */
  installedPackSlugFor(connection: { kind: 'mcp'; name: string }): Promise<string | null>;
  /** Runs the real probe, whose side effect is persisting `tool_hashes` into
   *  `ConnectionHealth`. Its return value is intentionally ignored: this task
   *  reads nothing back, it only causes the write that `handleMcpPackStatus`
   *  later reads at rest. */
  probe(args: { name: string; kind: 'mcp' }): Promise<unknown>;
  /** Structured failure sink. A probe failure is an expected runtime condition
   *  (a third party is down), not a programming error, so it must not abort the
   *  sweep for the connections after it. */
  onProbeError?(name: string, err: unknown): void;
}

export interface McpToolsDriftProbeResult {
  /** Connections that carried a generated pack and were probed. */
  probed: number;
  /** Connections skipped for having no generated pack. */
  skipped_no_pack: number;
  /** Probes that threw. Counted, never fatal. */
  failed: number;
}

/** Refresh the current-side tool hashes for every mcp connection backed by a
 *  generated pack. Pure sweep — returns counts, writes nothing itself. */
export const runMcpToolsDriftProbe = async (
  deps: McpToolsDriftProbeDeps,
): Promise<McpToolsDriftProbeResult> => {
  const result: McpToolsDriftProbeResult = { probed: 0, skipped_no_pack: 0, failed: 0 };

  for (const row of deps.listConnections({ kind: 'mcp' })) {
    const connection = { kind: 'mcp' as const, name: row.name };
    let packSlug: string | null;
    try {
      packSlug = await deps.installedPackSlugFor(connection);
    } catch (err) {
      // A lookup that throws is not "no pack" — collapsing them would silently
      // stop probing a connection that has one. Count it as a failure so the
      // number does not read as a clean skip.
      result.failed += 1;
      deps.onProbeError?.(row.name, err);
      continue;
    }
    if (packSlug === null) {
      result.skipped_no_pack += 1;
      continue;
    }
    try {
      await deps.probe(connection);
      result.probed += 1;
    } catch (err) {
      result.failed += 1;
      deps.onProbeError?.(row.name, err);
    }
  }

  return result;
};

export interface BuildMcpToolsDriftProbeTaskOptions {
  deps: McpToolsDriftProbeDeps;
}

/** Wrap the sweep as a `kind: 'core'` housekeeping task (D-123 idle cadence). */
export const buildMcpToolsDriftProbeTask = (
  opts: BuildMcpToolsDriftProbeTaskOptions,
): HousekeepingTaskInstance => ({
  meta: {
    id: MCP_TOOLS_DRIFT_PROBE_TASK_ID,
    description:
      'Re-read each MCP connection\'s tool list so a generated pack that has '
      + 'gone stale reports as drifted — the detection behind the badge. '
      + 'Refreshes hashes only; re-minting stays the owner\'s decision.',
    // ⛔ NOT interruptible — see limit 1 in the header. `step()` keeps no
    // partial cursor, so it must only be called with a full cycle budget.
    interruptible: false,
    kind: 'core',
  },
  async step(
    _ctx: HousekeepingContext,
    _cursor: HousekeepingCursor,
    _budget_ms: number,
  ): Promise<HousekeepingStepResult> {
    await runMcpToolsDriftProbe(opts.deps);
    return { cursor: { kind: 'complete' }, status: 'complete' };
  },
});
