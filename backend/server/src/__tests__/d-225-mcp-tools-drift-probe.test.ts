/** D-225 § 11 — the drift PROBE: what makes a stale pack report as stale.
 *
 *  Slice 2 shipped the badge over `ConnectionHealth.tool_hashes` and read it at
 *  rest, deliberately. What no test asked was who WRITES that field on a
 *  cadence — and the answer was nobody, so the badge could only report what was
 *  true at the owner's last manual action.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  buildMcpToolsDriftProbeTask,
  runMcpToolsDriftProbe,
  type McpToolsDriftProbeDeps,
} from '../housekeeping/tasks/mcp-tools-drift-probe.js';

/** A sweep over `named` connections, where `withPack` carry a generated pack. */
const deps = (
  named: string[],
  withPack: string[],
  over: Partial<McpToolsDriftProbeDeps> = {},
): McpToolsDriftProbeDeps & { probed: string[] } => {
  const probed: string[] = [];
  return {
    probed,
    listConnections: () => named.map((name) => ({ name })),
    installedPackSlugFor: async ({ name }) =>
      (withPack.includes(name) ? `mcp-${name}` : null),
    probe: async ({ name }) => { probed.push(name); },
    ...over,
  };
};

describe('D-225 § 11 — the mcp tool-drift probe sweep', () => {
  it('🔑 probes every mcp connection that has a generated pack', async () => {
    const d = deps(['a', 'b'], ['a', 'b']);
    const r = await runMcpToolsDriftProbe(d);
    expect(d.probed).toEqual(['a', 'b']);
    expect(r).toMatchObject({ probed: 2, skipped_no_pack: 0, failed: 0 });
  });

  it('⛔ SKIPS a connection with no generated pack — nothing to drift from', async () => {
    // The paired direction. Without it "it probed everything" would pass on a
    // sweep that ignored the pack lookup entirely, which is the difference
    // between a targeted refresh and outbound traffic for no decision.
    const d = deps(['has-pack', 'bare'], ['has-pack']);
    const r = await runMcpToolsDriftProbe(d);
    expect(d.probed).toEqual(['has-pack']);
    expect(r).toMatchObject({ probed: 1, skipped_no_pack: 1 });
  });

  it('⛔ one dead endpoint does not stop the connections after it', async () => {
    // A third party being down is an expected runtime condition, not a
    // programming error. If the sweep aborted on it, one dead server would
    // freeze drift detection for every OTHER connection — and the badge would
    // keep reporting `current` for all of them, which is the precise false
    // all-clear this whole task exists to remove.
    const probed: string[] = [];
    const errors: string[] = [];
    const r = await runMcpToolsDriftProbe({
      listConnections: () => [{ name: 'dead' }, { name: 'live' }],
      installedPackSlugFor: async ({ name }) => `mcp-${name}`,
      probe: async ({ name }) => {
        if (name === 'dead') throw new Error('ECONNREFUSED');
        probed.push(name);
      },
      onProbeError: (name) => errors.push(name),
    });
    expect(probed).toEqual(['live']);
    expect(errors).toEqual(['dead']);
    expect(r).toMatchObject({ probed: 1, failed: 1 });
  });

  it('⛔ a THROWING pack lookup counts as failed, never as a clean skip', async () => {
    // "No pack" and "could not tell" are different facts — the same distinction
    // `handleMcpPackStatus` draws between `no_pack` and `unknown`. Collapsing
    // them here would silently stop probing a connection that HAS a pack while
    // the counters read as a tidy skip.
    const r = await runMcpToolsDriftProbe({
      listConnections: () => [{ name: 'x' }],
      installedPackSlugFor: async () => { throw new Error('registry down'); },
      probe: async () => { throw new Error('must not be reached'); },
    });
    expect(r).toMatchObject({ probed: 0, skipped_no_pack: 0, failed: 1 });
  });

  it('only ever asks for mcp connections', async () => {
    const listConnections = vi.fn(() => []);
    await runMcpToolsDriftProbe({
      listConnections,
      installedPackSlugFor: async () => null,
      probe: async () => undefined,
    });
    expect(listConnections).toHaveBeenCalledWith({ kind: 'mcp' });
  });
});

describe('D-225 § 11 — the housekeeping task wrapper', () => {
  it('declares itself NOT interruptible', async () => {
    // It keeps no partial cursor, so a small remaining budget would start a
    // sweep it cannot resume. Asserted because the field is the entire contract
    // with the scheduler and is invisible at the call site.
    const task = buildMcpToolsDriftProbeTask({ deps: deps([], []) });
    expect(task.meta.interruptible).toBe(false);
    expect(task.meta.kind).toBe('core');
  });

  it('🔑 step() actually runs the sweep and completes', async () => {
    // ⛔ The wrapper is where a task can look wired and do nothing. Asserting
    // the sweep REACHED the probe is what separates a registered task from a
    // registered no-op.
    const d = deps(['a'], ['a']);
    const task = buildMcpToolsDriftProbeTask({ deps: d });
    const result = await task.step({} as never, { kind: 'start' } as never, 5_000);
    expect(d.probed).toEqual(['a']);
    expect(result.status).toBe('complete');
  });
});
