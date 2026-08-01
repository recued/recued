/** D-225 Slice 2b — the enrollment review chain and drift detection.
 *
 *  ⛔ The single most important assertion in this file is that a hint NEVER
 *  reaches the stored value. Everything else is mechanics.
 *
 *  If `readOnlyHint: true` seeded a row's STORED risk/approval, an owner who
 *  clicked Save without reading would have handed a third-party server auto-run
 *  permission — chosen by the server, with one boolean, bypassing both
 *  `confirm_risk_downgrade` and `isApprovalBelowRiskFloor` because the owner
 *  nominally consented. So: hints suggest, and Save-without-reading holds.
 */
import { describe, expect, it } from 'vitest';
import {
  normalizeBulkPackInstallPlan,
  parseBulkPackManifest,
  type IngredientManifest,
  type McpToolDescriptor,
} from '@recued/contracts';

import { decomposeComposition } from '../decomposer.js';
import {
  generateMcpPackComposition,
  mcpMintedHashes,
  mcpMintedHashesFromCatalog,
  mcpPackManifest,
  mcpPackReviewRows,
  mcpToolDescriptorHash,
  mcpToolsDrift,
} from '../mcp-pack.js';

const CONNECTION = { kind: 'mcp', name: 'recued_peer' };

describe('D-225 Slice 2b — review rows: the hint suggests, it does not decide', () => {
  it('⛔ a readOnlyHint NEVER moves the STORED value', async () => {
    // The exploit: a server claiming read-only on a tool that deletes. If the
    // hint seeded `stored`, Save-without-reading would auto-run it.
    const [row] = await mcpPackReviewRows([
      { name: 'delete_everything', read_only_hint: true },
    ]);
    expect(row!.stored).toEqual({ risk: 'write', approval: 'ask' });
  });

  it('offers it as a one-click SUGGESTION, clearly separate from stored', async () => {
    // The permitting half — the hint is not merely ignored, it does its real
    // job of making the right answer one click away.
    const [row] = await mcpPackReviewRows([{ name: 'list_files', read_only_hint: true }]);
    expect(row!.suggested).toEqual({ risk: 'read', approval: 'never' });
    expect(row!.server_says).toEqual({ read_only: true });
  });

  it('offers NO suggestion when the server claims both read-only and destructive', async () => {
    // Contradictory claims are not a basis for a shortcut.
    const [row] = await mcpPackReviewRows([
      { name: 'sync', read_only_hint: true, destructive_hint: true },
    ]);
    expect(row!.suggested).toBeUndefined();
    expect(row!.server_says).toEqual({ read_only: true, destructive: true });
  });

  it('offers no suggestion for a destructive claim — raising a tier needs no shortcut', async () => {
    const [row] = await mcpPackReviewRows([{ name: 'wipe', destructive_hint: true }]);
    expect(row!.suggested).toBeUndefined();
    expect(row!.stored).toEqual({ risk: 'write', approval: 'ask' });
    expect(row!.server_says).toEqual({ destructive: true });
  });

  it('a silent server produces a bare row — no badge, no suggestion', async () => {
    const [row] = await mcpPackReviewRows([{ name: 'thing' }]);
    expect(row!.server_says).toBeUndefined();
    expect(row!.suggested).toBeUndefined();
    expect(row!.stored).toEqual({ risk: 'write', approval: 'ask' });
  });

  it('EVERY row stores the conservative floor, whatever the server claims', async () => {
    const rows = await mcpPackReviewRows([
      { name: 'a', read_only_hint: true },
      { name: 'b', destructive_hint: true },
      { name: 'c' },
      { name: 'd', read_only_hint: false },
    ]);
    expect(rows).toHaveLength(4);
    for (const r of rows) expect(r.stored).toEqual({ risk: 'write', approval: 'ask' });
  });

  it('carries the op id and the REAL tool name', async () => {
    const [row] = await mcpPackReviewRows([
      { name: 'github/create-issue', description: 'Open an issue.' },
    ]);
    expect(row!.tool).toBe('github/create-issue');
    expect(row!.op).toMatch(/^github_create-issue_[a-f0-9]{8}$/);
    expect(row!.description).toBe('Open an issue.');
  });
});

describe('D-225 Slice 2b — drift is keyed on hashes, not names', () => {
  const listV1: McpToolDescriptor = { name: 'project.list', input_schema: { type: 'object' } };
  const listV2: McpToolDescriptor = {
    name: 'project.list',
    input_schema: { type: 'object', required: ['workspace'] },
  };

  it('⛔ detects a tool MUTATED IN PLACE — the case a name check is blind to', async () => {
    // Same name, new argument shape. A names-based comparison sees no change at
    // all, so the pack keeps declaring the old schema under the old op id and
    // keeps dispatching against a grant issued for a tool that no longer has
    // that shape. This is the entire reason drift is hash-keyed.
    const minted = await mcpMintedHashes([listV1]);
    const drift = await mcpToolsDrift(minted, [listV2]);
    expect(drift.added).toEqual([await mcpToolDescriptorHash(listV2)]);
    expect(drift.removed).toEqual([await mcpToolDescriptorHash(listV1)]);

    // …and the names are identical, which is what a name check would compare.
    expect(listV1.name).toBe(listV2.name);
  });

  it('reports NOTHING when the server is unchanged', async () => {
    // The permitting half. Drift that fired on every probe would train the
    // owner to dismiss the badge, which is the same as not having one.
    const minted = await mcpMintedHashes([listV1, { name: 'other' }]);
    const drift = await mcpToolsDrift(minted, [{ name: 'other' }, listV1]);
    expect(drift).toEqual({ added: [], removed: [] });
  });

  it('detects an added tool and a removed tool', async () => {
    const minted = await mcpMintedHashes([listV1, { name: 'legacy' }]);
    const drift = await mcpToolsDrift(minted, [listV1, { name: 'fresh' }]);
    expect(drift.added).toEqual([await mcpToolDescriptorHash({ name: 'fresh' })]);
    expect(drift.removed).toEqual([await mcpToolDescriptorHash({ name: 'legacy' })]);
  });

  it('an empty pack against an empty server is not drift', async () => {
    expect(await mcpToolsDrift([], [])).toEqual({ added: [], removed: [] });
  });

  it('minted hashes are sorted and stable, so a persisted snapshot compares cleanly', async () => {
    const a = await mcpMintedHashes([{ name: 'z' }, { name: 'a' }, { name: 'm' }]);
    const b = await mcpMintedHashes([{ name: 'm' }, { name: 'z' }, { name: 'a' }]);
    expect(a).toEqual(b);
    expect([...a].sort()).toEqual(a);
  });
});

describe('D-225 Slice 2b — the installable pack manifest', () => {
  it('wraps the composition under the generated publisher', async () => {
    const manifest = await mcpPackManifest({
      connection: CONNECTION,
      descriptors: [{ name: 'project.list' }],
    });
    expect(manifest.publisher).toBe('recued-local');
    expect(manifest.manifest_version).toBe(2);
    expect(manifest.version).toBe(1);
    expect(manifest.slug).toMatch(/^mcp-[a-f0-9]{32}$/);
    const contents = manifest.contents as { type: string; composition: { slug: string } }[];
    expect(contents).toHaveLength(1);
    expect(contents[0]!.type).toBe('composition');
    expect(contents[0]!.composition.slug).toBe(manifest.slug);
  });

  it('pins version 1 — a re-mint of the same tools is not an upgrade', async () => {
    // A bumping version would make every re-mint look like an upgrade to any
    // surface that reasons about versions, including the update review.
    const once = await mcpPackManifest({ connection: CONNECTION, descriptors: [{ name: 'a' }] });
    const twice = await mcpPackManifest({ connection: CONNECTION, descriptors: [{ name: 'a' }] });
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
  });

  it('names the pack for the owner, not for the derived slug', async () => {
    const manifest = await mcpPackManifest({
      connection: CONNECTION,
      descriptors: [{ name: 'a' }],
      display_name: 'Peer Project Server',
    });
    expect(manifest.name).toBe('Peer Project Server');
    expect(String(manifest.description)).toContain('read faithfully from the server');
  });

  it('🔑 PARSES + PLANS through the real pack pipeline — this is what Save installs', async () => {
    // The consumer proof. `handlePacksInstall` runs `parsePacksInstallArgs` then
    // `normalizeBulkPackInstallPlan`; if a generated manifest did not survive
    // both, the whole generator would be a declaration nothing can install —
    // and nothing upstream of here would have said so.
    const manifest = await mcpPackManifest({
      connection: CONNECTION,
      descriptors: [
        { name: 'project.list', input_schema: { type: 'object' } },
        { name: 'project.create', description: 'Create one.' },
      ],
    });

    const parsed = parseBulkPackManifest(manifest);
    expect(parsed.ok, parsed.ok ? '' : JSON.stringify(parsed)).toBe(true);
    if (!parsed.ok) throw new Error('unreachable');
    expect(parsed.manifest.publisher).toBe('recued-local');

    const plan = normalizeBulkPackInstallPlan(parsed.manifest);
    const compositions = plan.contents.filter((c) => c.type === 'composition');
    expect(compositions).toHaveLength(1);
  });

  it('a ONE-TOOL server still parses + plans', async () => {
    // The `force_catalog_lowering` case, end to end rather than at the
    // decomposer alone.
    const manifest = await mcpPackManifest({
      connection: CONNECTION,
      descriptors: [{ name: 'ping' }],
    });
    const parsed = parseBulkPackManifest(manifest);
    expect(parsed.ok, parsed.ok ? '' : JSON.stringify(parsed)).toBe(true);
  });

  it('🔑 minted hashes are DERIVED FROM THE PACK, not stored beside it', async () => {
    // One record of what was minted, and it is the artifact itself. A second
    // copy in the connection row could disagree with the pack it describes, and
    // the disagreement would be invisible — drift computed against a snapshot
    // no installed operation corresponds to.
    const descriptors: McpToolDescriptor[] = [
      { name: 'project.list', input_schema: { type: 'object' } },
      { name: 'ping' },
    ];
    const composition = await generateMcpPackComposition({
      connection: CONNECTION, descriptors,
    });
    const catalog = decomposeComposition[1]!(composition as never).catalog as IngredientManifest;

    // Round-trips exactly: the binding carries `tool` + `arguments_schema`,
    // which IS the hash preimage.
    expect(await mcpMintedHashesFromCatalog(catalog)).toEqual(await mcpMintedHashes(descriptors));
  });

  it('a pack derived from itself reports NO drift against the same server', async () => {
    // The end-to-end shape: mint from a probe, then compare the installed pack
    // against that same probe. Anything but empty here means the derivation and
    // the generator disagree about what was minted.
    const descriptors: McpToolDescriptor[] = [
      { name: 'a', input_schema: { type: 'object' } },
      { name: 'b' },
    ];
    const composition = await generateMcpPackComposition({ connection: CONNECTION, descriptors });
    const catalog = decomposeComposition[1]!(composition as never).catalog as IngredientManifest;
    const minted = await mcpMintedHashesFromCatalog(catalog);

    expect(await mcpToolsDrift(minted, descriptors)).toEqual({ added: [], removed: [] });

    // …and DOES report drift once the server mutates one of them.
    const mutated = await mcpToolsDrift(minted, [
      { name: 'a', input_schema: { type: 'object', required: ['x'] } },
      { name: 'b' },
    ]);
    expect(mutated.added).toHaveLength(1);
    expect(mutated.removed).toHaveLength(1);
  });
});
