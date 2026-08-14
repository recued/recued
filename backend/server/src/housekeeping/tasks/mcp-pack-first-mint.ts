/** D-225 auto-mint — `mcp-pack-first-mint`: the connections auto-mint could not
 *  reach, and the ones enrolled before auto-mint existed.
 *
 *  Minting a generated pack needs a live `tools/list`. An owner enrolling an mcp
 *  connection to a laptop that is asleep, a container that has not started, or a
 *  host behind a VPN they are not on right now must still be able to SAVE that
 *  connection — so `handleConnectionEnroll` mints best-effort and lets the row
 *  land either way. Something has to come back for it. This is that something.
 *
 *  🔑 **IT IS ALSO THE BACKFILL, at no extra cost.** A connection enrolled before
 *  auto-mint shipped is in the identical state as one whose mint was deferred:
 *  `mcpPackStatus` reads `no_pack`, and the repair is the same operation. There
 *  is no data migration and no separate one-shot script — the same sweep that
 *  retries a failure drains the backlog, because "has no pack" is one condition
 *  however it arose.
 *
 *  ── ⛔ WHY THIS IS NOT A LEG OF `mcp-tools-drift-probe` ────────────────────
 *  That task says so itself: *"Only mcp connections that HAVE an installed
 *  generated pack. A connection without one has nothing to drift FROM — its badge
 *  reads `no_pack` … a state no probe improves."* The two sweeps walk disjoint
 *  populations by design and answer opposite questions (has the pack gone stale /
 *  is there a pack at all). Folding them would give one task two exit conditions
 *  over two different sets.
 *
 *  ── ⛔⛔ AND WHY AN UNATTENDED MINT IS ALLOWED HERE AT ALL ─────────────────
 *  The drift probe's governing principle is *"auto-applying a re-mint would hand
 *  a third party the ability to change what it may do on the owner's server by
 *  editing its own `tools/list`. The probe writes a HASH; only the owner writes a
 *  GRANT."* That rule is about RE-minting — editing PAST an authorization the
 *  owner already gave.
 *
 *  This sweep never re-mints. `firstMintGeneratedPack` refuses any connection
 *  that already has a pack, so every mint here is a FIRST one: there is no prior
 *  authorization to edit past, and the pack it installs grants nothing (`write` +
 *  `ask`, `grant_default: off`, and every Tier-P op owner-default-only since
 *  § 234.4p.16e). The owner's decision — the grant — is untouched.
 *
 *  ⇒ **The boundary is enforced in ONE place**, inside the mint. This task does
 *  not re-check it; it calls the mint for every mcp connection and COUNTS what
 *  came back. A second copy of the rule here could disagree with the real one.
 *
 *  ⚠ Known limits of v1, named rather than implied — the same two
 *  `mcp-tools-drift-probe` carries, for the same reasons:
 *
 *  1. NOT interruptible. `step()` runs one sweep and keeps no partial cursor, so
 *     a small remaining budget would start work it cannot resume. Each entry that
 *     lacks a pack costs a network round trip; connections that HAVE one cost a
 *     hash and a registry lookup, because the mint checks before it probes.
 *  2. NO BACKOFF. A permanently unreachable endpoint is re-probed every idle
 *     cycle, forever, because "has no pack" never stops being true for it. The
 *     cost is outbound noise, not incorrectness (`deferred` is counted, the sweep
 *     survives it) — but this is the task where a v2 backoff would pay most, and
 *     "recently failed" is a policy number that should not be invented here.
 */

import type {
  ConnectionKind,
  HousekeepingCursor,
  HousekeepingStepResult,
} from '@recued/contracts';

import type { McpFirstMintOutcome } from '../../connection-handler.js';
import type { HousekeepingContext, HousekeepingTaskInstance } from '../registry.js';

export const MCP_PACK_FIRST_MINT_TASK_ID = 'mcp-pack-first-mint';

/** The narrow surface this task needs.
 *
 *  🔑 Deliberately not `ConnectionRpcDeps`, following `mcp-tools-drift-probe`:
 *  this task's whole job is to cause a REAL mint against a REAL endpoint, and a
 *  dependency wide enough to stub the mint would let a test certify a sweep that
 *  installed nothing. Wiring passes the real `firstMintGeneratedPack` and the
 *  real store. */
export interface McpPackFirstMintDeps {
  /** Every enrolled connection of a kind. */
  listConnections(query: { kind: ConnectionKind }): readonly { name: string }[];
  /** Mint this connection's pack IF it has none. Returns its outcome; the
   *  already-installed refusal is one of them, and that refusal — not a check in
   *  this file — is what keeps the sweep to first mints. */
  firstMint(connection: { kind: 'mcp'; name: string }): Promise<McpFirstMintOutcome>;
  /** Structured failure sink. A mint that THREW (rather than returning
   *  `deferred`) is unexpected, but it must still not abort the sweep for the
   *  connections after it. */
  onMintError?(name: string, err: unknown): void;
}

export interface McpPackFirstMintResult {
  /** Connections that had no pack and now have one. */
  minted: number;
  /** Connections that already had a pack — the ordinary steady state. */
  skipped_has_pack: number;
  /** Connections on a host that cannot install or cannot tell whether a pack
   *  exists. Kept apart from `skipped_has_pack`: "nothing to do" and "cannot
   *  tell" are different facts, and only the second is a wiring problem. */
  skipped_unavailable: number;
  /** Mints that could not complete — usually an unreachable server. The
   *  connection stays at `no_pack`, so the next cycle tries again. */
  deferred: number;
}

/** Mint a pack for every mcp connection that has none. Returns counts; the
 *  writes are the mint's own. */
export const runMcpPackFirstMint = async (
  deps: McpPackFirstMintDeps,
): Promise<McpPackFirstMintResult> => {
  const result: McpPackFirstMintResult = {
    minted: 0,
    skipped_has_pack: 0,
    skipped_unavailable: 0,
    deferred: 0,
  };

  for (const row of deps.listConnections({ kind: 'mcp' })) {
    const connection = { kind: 'mcp' as const, name: row.name };
    let outcome: McpFirstMintOutcome;
    try {
      outcome = await deps.firstMint(connection);
    } catch (err) {
      // The mint reports its own failures as `deferred` rather than throwing, so
      // reaching here means something below it broke. Count it as deferred — the
      // connection is still packless and still worth retrying — and surface it.
      result.deferred += 1;
      deps.onMintError?.(row.name, err);
      continue;
    }
    if (outcome.status === 'minted') result.minted += 1;
    else if (outcome.status === 'deferred') result.deferred += 1;
    else if (outcome.reason === 'already_installed') result.skipped_has_pack += 1;
    else result.skipped_unavailable += 1;
  }

  return result;
};

export interface BuildMcpPackFirstMintTaskOptions {
  deps: McpPackFirstMintDeps;
}

/** Wrap the sweep as a `kind: 'core'` housekeeping task (D-123 idle cadence). */
export const buildMcpPackFirstMintTask = (
  opts: BuildMcpPackFirstMintTaskOptions,
): HousekeepingTaskInstance => ({
  meta: {
    id: MCP_PACK_FIRST_MINT_TASK_ID,
    description:
      'Generate the pack for each MCP connection that has none — the retry for a '
      + 'server that was unreachable when it was enrolled, and the backfill for '
      + 'connections enrolled before packs were minted automatically. Never '
      + 're-mints: an existing pack is the owner\'s to refresh.',
    // ⛔ NOT interruptible — see limit 1 in the header.
    interruptible: false,
    kind: 'core',
  },
  async step(
    _ctx: HousekeepingContext,
    _cursor: HousekeepingCursor,
    _budget_ms: number,
  ): Promise<HousekeepingStepResult> {
    await runMcpPackFirstMint(opts.deps);
    return { cursor: { kind: 'complete' }, status: 'complete' };
  },
});
