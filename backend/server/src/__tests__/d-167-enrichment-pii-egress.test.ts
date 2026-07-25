/** D-167 — non-chat (enrichment-producer) AI-egress PII aliasing.
 *
 *  Pins the per-record alias seam (`wrapHousekeepingCtxForRecord`): an AI
 *  producer's `ctx.llm` / `ctx.llmWithMeta` call aliases known PII in the
 *  LLM-bound packet (seeded from the source record's MetaField.privacy-tagged
 *  structured fields) before egress, and restores the model output before the
 *  producer parses it — so only the model sees aliases while the enrichment
 *  value sees real values (spec §"Runtime flow", §Hard invariant). Also pins
 *  the behavior-preserving no-op paths (the comfort default until a tag source
 *  is wired) and the fail-open guarantee (aliasing may miss, never breaks a
 *  producer).
 */

import type {
  EnrichmentScope,
  IngredientManifest,
  PiiFieldTag,
} from '@recued/contracts';
import { describe, expect, it, vi } from 'vitest';

import { wrapHousekeepingCtxForRecord } from '../housekeeping/enrichment-pii-egress.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';

const MANIFEST = {} as IngredientManifest;

/** Tags a mail-shaped record's sender email + name. */
const mailTagSource = (scope: EnrichmentScope): readonly PiiFieldTag[] =>
  scope === 'mail'
    ? [
        { path: 'sender_email', kind: 'email' },
        { path: 'sender_name', kind: 'name' },
      ]
    : [];

/** A minimal ctx carrying only the fields the wrap reads. */
const makeCtx = (over: Partial<HousekeepingContext> = {}): HousekeepingContext =>
  ({
    enrichmentPiiTagSource: mailTagSource,
    ...over,
  }) as unknown as HousekeepingContext;

const RECORD = { sender_email: 'alice@acme.com', sender_name: 'Alice Chen' };

describe('D-167 enrichment-pii-egress — wrapHousekeepingCtxForRecord', () => {
  it('aliases known PII in llm.data on egress and restores the model output (llmWithMeta)', async () => {
    const egress: Array<Record<string, unknown>> = [];
    const llmWithMeta = vi.fn(async (_m: IngredientManifest, input: Record<string, unknown>) => {
      egress.push(input);
      // The model echoes the (aliased) blob it was shown into its output.
      return { result: { note: `re: ${String(input['llm.data'])}` }, model_id: 'prov:m' };
    });
    const ctx = makeCtx({ llmWithMeta });

    const wrapped = wrapHousekeepingCtxForRecord(ctx, 'mail', RECORD);
    const out = await wrapped.llmWithMeta!(MANIFEST, {
      'llm.data': 'Alice Chen (alice@acme.com) asked about renewal',
      'llm.fields': ['action_items'],
    });

    // Egress: the model never saw the real name or email.
    const sentBlob = String(egress[0]?.['llm.data']);
    expect(sentBlob).toContain('pii.Person1');
    expect(sentBlob).not.toContain('Alice Chen');
    expect(sentBlob).not.toContain('alice@acme.com');
    // Control fields pass through untouched.
    expect(egress[0]?.['llm.fields']).toEqual(['action_items']);
    // Restore: the producer-visible output carries the REAL values again.
    const note = (out.result as { note: string }).note;
    expect(note).toContain('Alice Chen');
    expect(note).toContain('alice@acme.com');
    expect(note).not.toContain('pii.Person1');
    expect(out.model_id).toBe('prov:m');
  });

  it('aliases + restores on the bare ctx.llm path too', async () => {
    let sent: Record<string, unknown> | undefined;
    const llm = vi.fn(async (_m: IngredientManifest, input: Record<string, unknown>) => {
      sent = input;
      return { summary: `about ${String(input['llm.data'])}` };
    });
    const wrapped = wrapHousekeepingCtxForRecord(makeCtx({ llm }), 'mail', RECORD);

    const result = (await wrapped.llm!(MANIFEST, {
      'llm.data': 'note from Alice Chen',
    })) as { summary: string };

    expect(String(sent?.['llm.data'])).toContain('pii.Person1');
    expect(String(sent?.['llm.data'])).not.toContain('Alice Chen');
    expect(result.summary).toContain('Alice Chen');
    expect(result.summary).not.toContain('pii.Person1');
  });

  it('reuses one alias for a value repeated across the blob (ledger consistency)', async () => {
    let sent: string | undefined;
    const llm = vi.fn(async (_m: IngredientManifest, input: Record<string, unknown>) => {
      sent = String(input['llm.data']);
      return { ok: true };
    });
    const wrapped = wrapHousekeepingCtxForRecord(makeCtx({ llm }), 'mail', RECORD);
    await wrapped.llm!(MANIFEST, { 'llm.data': 'Alice Chen and Alice Chen again' });
    // Both mentions collapse to the SAME alias.
    expect(sent).toBe('pii.Person1 and pii.Person1 again');
  });

  it('is a no-op (returns the same ctx) when no tag source is wired', () => {
    const llm = vi.fn();
    const ctx = makeCtx({ enrichmentPiiTagSource: undefined, llm });
    expect(wrapHousekeepingCtxForRecord(ctx, 'mail', RECORD)).toBe(ctx);
  });

  it('is a no-op when the scope resolves no tags', () => {
    const llm = vi.fn();
    const ctx = makeCtx({ llm });
    // 'contact' is not tagged by mailTagSource.
    expect(wrapHousekeepingCtxForRecord(ctx, 'contact' as EnrichmentScope, RECORD)).toBe(ctx);
  });

  it('is a no-op when the record carries no tagged value to seed', () => {
    const llm = vi.fn();
    const ctx = makeCtx({ llm });
    expect(wrapHousekeepingCtxForRecord(ctx, 'mail', { unrelated: 'x' })).toBe(ctx);
  });

  it('is a no-op when neither llm nor llmWithMeta is wired', () => {
    const ctx = makeCtx({});
    expect(wrapHousekeepingCtxForRecord(ctx, 'mail', RECORD)).toBe(ctx);
  });

  it('passes a non-string llm.data through raw (comfort miss, never a throw)', async () => {
    let sent: unknown;
    const llm = vi.fn(async (_m: IngredientManifest, input: Record<string, unknown>) => {
      sent = input['llm.data'];
      return { ok: true };
    });
    const wrapped = wrapHousekeepingCtxForRecord(makeCtx({ llm }), 'mail', RECORD);
    const batch = [{ body: 'Alice Chen' }];
    await wrapped.llm!(MANIFEST, { 'llm.data': batch });
    // Non-string payload is not aliased (a documented Slice-1 limitation).
    expect(sent).toEqual(batch);
  });

  it('fails open to the raw ctx when the tag source throws (producer never breaks)', () => {
    const llm = vi.fn();
    const ctx = makeCtx({
      llm,
      enrichmentPiiTagSource: () => {
        throw new Error('boom');
      },
    });
    expect(wrapHousekeepingCtxForRecord(ctx, 'mail', RECORD)).toBe(ctx);
  });
});
