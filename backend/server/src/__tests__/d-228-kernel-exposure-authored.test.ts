/** D-228 slice 2 (2nd attempt) — kernel MCP exposure is an AUTHORED field,
 *  `IngredientManifest.mcp_exposed`, not a hand-list and not a derivation.
 *
 *  ⛔⛔ WHY NOT DERIVED, pinned here because it is the whole reason this file
 *  replaced `d-228-kernel-exposure-derived.test.ts` (attempt 1, reverted) and
 *  then `…-whitelist.test.ts` (the revert). Attempt 1 used
 *  `risk_tier === 'read'`, which promoted a presentation hint to an
 *  authorization input; a Codex review found four `read`-tier kernel manifests
 *  that are not safe reads. But RE-AUTHORING `risk_tier` would not have rescued
 *  the derivation, and that is the finding that forced a field:
 *
 *    data-file-read          kind: storage   risk_tier: read   MUST be exposed
 *    webhook-watcher         kind: storage   risk_tier: read   must NOT be
 *    time-relative-watcher   kind: storage   risk_tier: read   must NOT be
 *    file-watcher            kind: storage   risk_tier: read   must NOT be
 *    recipe-watcher          kind: storage   risk_tier: read   must NOT be
 *
 *  Identical on every authored field that could have carried the decision. The
 *  judgement was never written down — it lived in a `new Set([...])` in one
 *  server file's private scope — and a derivation cannot recover a decision that
 *  was never recorded. So it is recorded, on the manifest.
 *
 *  ⚠ GRANTABLE, NOT EXPOSED: clearing this fence makes an ingredient possible to
 *  grant. Since slice 6 a caller with no per-tool checklist is offered nothing. */

import { describe, expect, it } from 'vitest';
import type { IngredientManifest } from '@recued/contracts';

import { _testing } from '../mcp-server.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';

const kernel = (over: Record<string, unknown>): IngredientManifest =>
  ({ author: 'recued', kind: 'storage', risk_tier: 'read', ...over } as unknown as IngredientManifest);

const community = (over: Record<string, unknown>): IngredientManifest =>
  ({ author: 'acme', kind: 'api', risk_tier: 'write', ...over } as unknown as IngredientManifest);

const exposed = (m: IngredientManifest): boolean =>
  (_testing as { isMcpExposedKernelIngredient: (m: IngredientManifest) => boolean })
    .isMcpExposedKernelIngredient(m);

describe('the kernel fence reads the AUTHORED field', () => {
  /** ⛔⛔ FAIL-CLOSED BY OMISSION — the property the hand-list could not have.
   *  A kernel ingredient added tomorrow and never considered ships FENCED. */
  it('a kernel ingredient with no `mcp_exposed` is fenced', () => {
    expect(exposed(kernel({ slug: 'brand-new-kernel-thing' }))).toBe(false);
  });

  /** ⚠ THE PERMITTING WITNESS. Without it, "fenced" is indistinguishable from a
   *  predicate that returns false for every kernel manifest — which would
   *  silently un-expose the D-172 file-content read surface. */
  it('`mcp_exposed: true` clears the fence', () => {
    expect(exposed(kernel({ slug: 'data-file-read', mcp_exposed: true }))).toBe(true);
  });

  it('`mcp_exposed: false` is fenced, explicitly', () => {
    expect(exposed(kernel({ slug: 'x', mcp_exposed: false }))).toBe(false);
  });

  /** ⛔⛔ THE ANTI-DERIVATION GUARD. Every one of these is `(storage, read)` —
   *  the exact shape `data-file-read` has. If exposure is ever re-derived from
   *  `risk_tier` (or from kind, or from both), these flip to `true` and this
   *  test reds. That is its only job. */
  it('the (storage, read) manifests that must stay fenced, do', () => {
    for (const slug of [
      'webhook-watcher', 'time-relative-watcher', 'file-watcher', 'recipe-watcher',
    ]) {
      expect(exposed(kernel({ slug })), `${slug} must stay fenced`).toBe(false);
    }
    // …and the two whose danger is ambient authority rather than damage class,
    // which is exactly why `risk_tier` was never going to express it.
    expect(exposed(kernel({ slug: 'http-watcher', kind: 'http' }))).toBe(false);
    expect(exposed(kernel({ slug: 'connection-mcp-read', kind: 'connection' }))).toBe(false);
  });

  /** ⛔ THE PERMITTING WITNESS for the `author !== 'recued'` half — otherwise this
   *  suite could not tell a KERNEL rule from a blanket fence applied to everyone.
   *  Community ingredients clear THIS fence at every tier; the KIND fence and the
   *  grant gate govern them. */
  it('a community ingredient clears the KERNEL fence regardless of the field', () => {
    expect(exposed(community({ slug: 'acme-writer' }))).toBe(true);
    expect(exposed(community({ slug: 'acme-thing', mcp_exposed: false }))).toBe(true);
  });
});

describe('the REAL kernel manifests', () => {
  /** ⛔⛔ CORPUS SWEEP, not a fixture. The per-manifest tests above would all
   *  pass while the shipped `data-file-read` quietly lost its opt-in — the
   *  reverted attempt taught exactly that lesson at the other end (a derived
   *  rule nobody re-read). This asserts the SHIPPED set. */
  it('exposes EXACTLY the intended set', () => {
    const flagged = KERNEL_MANIFESTS
      .filter((m) => (m as { mcp_exposed?: boolean }).mcp_exposed === true)
      .map((m) => m.slug)
      .sort();
    // ⚠ Asserts the sweep FOUND something first — an empty result would satisfy
    // a `toEqual([])`-shaped expectation while meaning the probe was broken.
    expect(flagged.length).toBeGreaterThan(0);
    // ⚠ D-244 added the three CSV readers. Admitted deliberately, not bumped:
    // each is `kind: 'storage'`, `risk_tier: 'read'`, and carries an EXPLICIT
    // `mcp_exposed: true` — the same shape as `data-file-read`, which this list
    // already held. A read-tier storage op costs the owner nothing to run and
    // reaches only a file the caller already named.
    //
    // ⛔ The point of this ratchet is that widening MCP's kernel reach is a
    // visible decision. If a future entry is not read-tier, do not add it here
    // — ask why it is exposed at all.
    //
    // ── D-261, 2026-09-06 — five entries, and THREE ARE NOT READ-TIER. The
    //    question above is therefore answered here rather than waved through.
    //
    // `preapproval-request` (read) is the easy half: it is inert by
    // construction. It prepares a proposal and returns a reference; the D-261
    // decision is recorded ONLY by the protected owner ask, which rejects
    // generic settlement (`notification/src/index.ts` — `submitAnswer` /
    // `cancelAsk` / `registerAskHandler` all throw on the protected kind). No
    // model, recipe or MCP caller can move a proposal to approved.
    //
    // `mail-draft-{create,update}` (write) and `mail-draft-delete`
    // (DESTRUCTIVE) are the ones this ratchet exists to stop. They are admitted
    // because their damage class is bounded by the store, not by hope:
    //   - Every method funnels through `mail-drafts.ts` `read()`, which requires
    //     the same `owner_id` AND — for a contract caller — the same
    //     `contract_id`. A caller reaches only drafts it authored itself; the
    //     principal is host-derived and "never a wire argument".
    //   - `update` / `delete` additionally require the current
    //     `expected_revision`, so neither can act on a draft it has not read.
    //   - The manifest states the boundary the slug cannot cross: the operation
    //     "cannot send, schedule or approve a message". Sending stays behind
    //     `mail-send`; scheduling stays behind the owner decision.
    // So `destructive` here means "deletes the caller's own local draft", not
    // "reaches owner content" — which is the distinction `risk_tier` alone was
    // never going to express, and the reason this list is authored.
    //
    // ⚠ The `preapproval.` / `mail.drafts.` RPC namespaces are the OTHER half of
    // the same decision, and they went the other way: both are in
    // `MCP_RESERVED_RPC_PREFIXES`, so the owner control plane stays unreachable
    // from this channel. An agent gets the governed kernel ops and nothing else.
    expect(flagged).toEqual([
      'csv-columns', 'csv-filter', 'csv-rows', 'csv-stats', 'data-file-read',
      'mail-draft-create', 'mail-draft-delete', 'mail-draft-read',
      'mail-draft-update', 'preapproval-request',
    ]);
  });

  it('and reproduces the retired whitelist\'s outcome over the real manifests', () => {
    const reachable = KERNEL_MANIFESTS.filter((m) => m.author === 'recued' && exposed(m));
    // ⚠ SORTED, like the sibling above. Unsorted this asserted the order the
    // manifests happen to be DECLARED in — incidental, and it broke the moment
    // a new entry landed between two existing ones. The property is which slugs
    // are reachable, not the file's layout.
    expect(reachable.map((m) => m.slug).sort()).toEqual([
      'csv-columns', 'csv-filter', 'csv-rows', 'csv-stats', 'data-file-read',
      'mail-draft-create', 'mail-draft-delete', 'mail-draft-read',
      'mail-draft-update', 'preapproval-request',
    ]);
  });
});
