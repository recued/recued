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

  // D-316 — background AI gets the chat's standard: the WHOLE input is aliased,
  // structured included, and an aliasing error means no call. Until D-316 a
  // batched `llm.data` went out raw ("a comfort miss") and every aliasing error
  // fell open to the raw input.
  it('aliases a batched (array) llm.data, the D-162 batch shape', async () => {
    let sent: unknown;
    const llm = vi.fn(async (_m: IngredientManifest, input: Record<string, unknown>) => {
      sent = input['llm.data'];
      return [{ id: 'r1', summary: 'asked by pii.Person1' }];
    });
    const wrapped = wrapHousekeepingCtxForRecord(makeCtx({ llm }), 'mail', RECORD);
    const batch = [{ id: 'r1', body: 'Alice Chen (alice@acme.com) asked about renewal' }];
    const result = (await wrapped.llm!(MANIFEST, {
      'llm.data': batch,
      'llm.id_field': 'id',
    })) as Array<{ summary: string }>;
    const sentJson = JSON.stringify(sent);
    expect(sentJson).toContain('pii.Person1');
    expect(sentJson).not.toContain('Alice Chen');
    expect(sentJson).not.toContain('alice@acme.com');
    // The caller's own value is never mutated.
    expect(batch[0]?.body).toContain('Alice Chen');
    // Restore: the producer sees real values again.
    expect(result[0]?.summary).toBe('asked by Alice Chen');
  });

  it('aliases a nested object llm.data', async () => {
    let sent: unknown;
    const llm = vi.fn(async (_m: IngredientManifest, input: Record<string, unknown>) => {
      sent = input['llm.data'];
      return { ok: true };
    });
    const wrapped = wrapHousekeepingCtxForRecord(makeCtx({ llm }), 'mail', RECORD);
    await wrapped.llm!(MANIFEST, {
      'llm.data': { thread: { messages: [{ from: 'Alice Chen <alice@acme.com>' }] } },
    });
    const sentJson = JSON.stringify(sent);
    expect(sentJson).not.toContain('Alice Chen');
    expect(sentJson).not.toContain('alice@acme.com');
  });

  it('aliases a known value used as a key, and restores the key in the output', async () => {
    let sent: unknown;
    const llm = vi.fn(async (_m: IngredientManifest, input: Record<string, unknown>) => {
      sent = input['llm.data'];
      // The model keys its answer by the (aliased) key it was shown.
      const keys = Object.keys(input['llm.data'] as Record<string, unknown>);
      return { by_sender: { [keys[0]!]: 'renewal' } };
    });
    const wrapped = wrapHousekeepingCtxForRecord(makeCtx({ llm }), 'mail', RECORD);
    const result = (await wrapped.llm!(MANIFEST, {
      'llm.data': { 'alice@acme.com': 'asked about renewal' },
    })) as { by_sender: Record<string, string> };
    expect(JSON.stringify(sent)).not.toContain('alice@acme.com');
    expect(result.by_sender).toEqual({ 'alice@acme.com': 'renewal' });
  });

  it('makes no call when aliasing the input throws', async () => {
    const llm = vi.fn(async () => ({ ok: true }));
    const llmWithMeta = vi.fn(async () => ({ result: { ok: true }, model_id: 'prov:m' }));
    const wrapped = wrapHousekeepingCtxForRecord(makeCtx({ llm, llmWithMeta }), 'mail', RECORD);
    // A value the aliasing walk cannot read: its getter throws mid-walk.
    const unreadable = (): Record<string, unknown> => {
      const data: Record<string, unknown> = {};
      Object.defineProperty(data, 'body', {
        enumerable: true,
        get: () => {
          throw new Error('unreadable');
        },
      });
      return data;
    };
    await expect(wrapped.llm!(MANIFEST, { 'llm.data': unreadable() })).rejects.toThrow(
      /could not alias/,
    );
    await expect(wrapped.llmWithMeta!(MANIFEST, { 'llm.data': unreadable() })).rejects.toThrow(
      /could not alias/,
    );
    expect(llm).not.toHaveBeenCalled();
    expect(llmWithMeta).not.toHaveBeenCalled();
  });

  it('makes no call when the tag source throws, instead of sending raw', async () => {
    const llm = vi.fn(async () => ({ ok: true }));
    const ctx = makeCtx({
      llm,
      enrichmentPiiTagSource: () => {
        throw new Error('boom');
      },
    });
    const wrapped = wrapHousekeepingCtxForRecord(ctx, 'mail', RECORD);
    await expect(
      wrapped.llm!(MANIFEST, { 'llm.data': 'note from Alice Chen' }),
    ).rejects.toThrow(/could not alias/);
    expect(llm).not.toHaveBeenCalled();
  });

  it('keeps an alias-shaped literal in the content as written (the chat pre-scan)', async () => {
    // Seeding gives Alice Chen `pii.Person1`. Without the chat's collision
    // pre-scan, a literal `pii.Person1` in the text is restored to her name.
    const llm = vi.fn(async (_m: IngredientManifest, input: Record<string, unknown>) => ({
      echo: input['llm.data'],
    }));
    const wrapped = wrapHousekeepingCtxForRecord(makeCtx({ llm }), 'mail', RECORD);
    const text = 'pii.Person1 is a placeholder; the sender is Alice Chen';
    const result = (await wrapped.llm!(MANIFEST, { 'llm.data': text })) as { echo: string };
    expect(result.echo).toBe(text);
  });

  it('sends a string with nothing to alias unchanged — that is not a failure', async () => {
    let sent: unknown;
    const llm = vi.fn(async (_m: IngredientManifest, input: Record<string, unknown>) => {
      sent = input['llm.data'];
      return { ok: true };
    });
    const wrapped = wrapHousekeepingCtxForRecord(makeCtx({ llm }), 'mail', RECORD);
    await wrapped.llm!(MANIFEST, { 'llm.data': 'quarterly renewal reminder' });
    expect(sent).toBe('quarterly renewal reminder');
    expect(llm).toHaveBeenCalledTimes(1);
  });
});
