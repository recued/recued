/** D-323 — the offers for packs a chat call came back needing: a run or a
 *  schedule refused `pack_not_installed`, or `document.read` with no reader
 *  pack. Read from the refusal's data, turned into offers from the catalogue
 *  copy, and only on the owner's own turns. */

import { describe, expect, it, vi } from 'vitest';
import {
  RpcError,
  type ChatDispatchContext,
  type ChatDispatchResult,
  type InstallOffer,
  type InternalToolRegistry,
  type ToolEntry,
} from '@recued/contracts';

import type { MarketplaceCatalogue, MarketplaceCatalogueSnapshot } from '../catalogue.js';
import {
  createNeededPackOffers,
  missingPacksOfRefusal,
  neededPacksSentence,
  wrapRegistryWithNeededPackOffers,
} from '../needed-packs.js';
import { FIRST_CATALOGUE_WAIT_MS } from '../source.js';

const pack = (slug: string, name: string, publisher_id = 'recued-core', publisher_certified = true) =>
  ({ slug, name, tags: [], publisher_id, publisher_certified });

const SNAPSHOT: MarketplaceCatalogueSnapshot = {
  packs: [
    pack('docling', 'Docling'),
    pack('markitdown', 'MarkItDown'),
    pack('whisper', 'Whisper'),
    pack('ffmpeg', 'FFmpeg'),
    pack('unvetted', 'Unvetted', 'recued-core', false),
    pack('ledger', 'Acme Ledger', 'acme'),
  ],
  recipes: [],
  fetched_at: 0,
};

const catalogue = (copy: MarketplaceCatalogueSnapshot | null, readies: number[] = []): MarketplaceCatalogue => ({
  current: () => copy,
  ensureFresh: () => undefined,
  refresh: async () => undefined,
  ready: async (waitMs) => { readies.push(waitMs); return copy; },
});

const offersOver = (copy: MarketplaceCatalogueSnapshot | null, installed: string[] = []) => createNeededPackOffers({
  catalogue: catalogue(copy),
  enabled: () => true,
  installedPackSlugs: () => new Set(installed),
});

const DOCLING: InstallOffer = { kind: 'pack', slug: 'docling', name: 'Docling', publisher: 'recued-core', recipes: [] };
const MARKITDOWN: InstallOffer = { kind: 'pack', slug: 'markitdown', name: 'MarkItDown', publisher: 'recued-core', recipes: [] };

describe('the packs a refusal names', () => {
  it('are its typed list, as the run and the schedule throw it', () => {
    const refusal = new RpcError('pack_not_installed', 'needs packs', 400, undefined, {
      missing_packs: ['recued-core.docling', 'recued-core.whisper'],
    });
    expect(missingPacksOfRefusal(refusal)).toEqual(['recued-core.docling', 'recued-core.whisper']);
  });

  it('⛔ are never read from the message', () => {
    expect(missingPacksOfRefusal(new RpcError('pack_not_installed', 'needs recued-core.docling', 400))).toEqual([]);
  });

  it('are none for any other error, or a list that is not one', () => {
    expect(missingPacksOfRefusal(new RpcError('bad_request', 'x', 400, undefined, { missing_packs: ['recued-core.docling'] })))
      .toEqual([]);
    expect(missingPacksOfRefusal(new Error('engine boom'))).toEqual([]);
    expect(missingPacksOfRefusal(undefined)).toEqual([]);
    expect(missingPacksOfRefusal({ code: 'pack_not_installed', details: { missing_packs: 'recued-core.docling' } })).toEqual([]);
    expect(missingPacksOfRefusal({ code: 'pack_not_installed', details: { missing_packs: ['', 7, 'recued-core.docling'] } }))
      .toEqual(['recued-core.docling']);
  });
});

describe('the offers for needed packs', () => {
  it('are the catalogue’s packs under the same publisher and slug, in the order named', async () => {
    expect(await offersOver(SNAPSHOT)(['recued-core.markitdown', 'recued-core.docling'])).toEqual([MARKITDOWN, DOCLING]);
  });

  it('⛔ leave out what is installed, an uncertified publisher, and a pack the marketplace does not list', async () => {
    const offers = offersOver(SNAPSHOT, ['markitdown']);
    expect(await offers([
      'recued-core.markitdown', // installed
      'recued-core.unvetted', // uncertified publisher (ruling P4)
      'recued-local.my-pack', // a local pack: its page could not install it
      'acme.docling', // the slug, under another publisher
      'docling', // no publisher
      'recued-core.docling',
    ])).toEqual([DOCLING]);
  });

  it('are three at most, each once', async () => {
    const offers = await offersOver(SNAPSHOT)([
      'recued-core.docling', 'recued-core.docling', 'recued-core.markitdown', 'recued-core.whisper', 'recued-core.ffmpeg',
    ]);
    expect(offers.map((offer) => offer.slug)).toEqual(['docling', 'markitdown', 'whisper']);
  });

  it('wait for a new server’s first download as a search does, and are none without a copy', async () => {
    const readies: number[] = [];
    const offers = createNeededPackOffers({ catalogue: catalogue(null, readies), enabled: () => true, installedPackSlugs: () => new Set() });
    expect(await offers(['recued-core.docling'])).toEqual([]);
    expect(readies).toEqual([FIRST_CATALOGUE_WAIT_MS]);
  });

  it('⛔ are none, and download nothing, when the owner turned offers off', async () => {
    const readies: number[] = [];
    const offers = createNeededPackOffers({ catalogue: catalogue(SNAPSHOT, readies), enabled: () => false, installedPackSlugs: () => new Set() });
    expect(await offers(['recued-core.docling'])).toEqual([]);
    expect(readies).toEqual([]);
  });
});

describe('what the model reads beside them', () => {
  it('names each pack, says the owner installs it from the link, and that it cannot', () => {
    const one = neededPacksSentence([DOCLING]);
    expect(one).toContain('The pack "Docling" is in the Recued marketplace, not installed.');
    expect(one).toContain('The owner sees it as a link under your answer');
    expect(one).toContain('You cannot install a pack');
    expect(one).toContain('Never say you installed it.');
    expect(neededPacksSentence([MARKITDOWN, DOCLING]))
      .toContain('The packs "MarkItDown" and "Docling" are in the Recued marketplace, not installed. The owner sees each one');
  });
});

const ctx: ChatDispatchContext = {
  channel: 'internal_function_call',
  session_id: 's1',
  turn_id: 't1',
  execution_source: { channel: 'chat', actor: 'user_self', chat_session_id: 's1', user_id: 'owner' },
};

const REFUSAL: ChatDispatchResult = {
  ok: false,
  reason: 'execution_error',
  detail: "Recipe 'parse-a-pdf' needs a pack that is not installed: recued-core.docling. Install it and run again.",
  missing_packs: ['recued-core.docling'],
};

const TOOL: ToolEntry = {
  name: 'recipe.run', tier: 1, description: 'run a recipe', arg_schema: { type: 'object' },
  topic_tags: [], classification: 'unknown', concurrency_safe: false,
};

const registryAnswering = (result: ChatDispatchResult): InternalToolRegistry => ({
  list: () => [TOOL],
  listByTier: () => [TOOL],
  getByName: (name) => (name === TOOL.name ? TOOL : null),
  dispatch: async () => result,
  subscribeRefresh: () => () => undefined,
});

const wrapped = (
  result: ChatDispatchResult,
  options: { offers?: (refs: ReadonlyArray<string>) => Promise<InstallOffer[]>; guard?: () => void } = {},
) => wrapRegistryWithNeededPackOffers(registryAnswering(result), {
  offers: options.offers ?? (async () => [DOCLING]),
  ...(options.guard !== undefined ? { ownerCatalogGuard: options.guard } : {}),
});

describe('the chat registry, with offers on a call that came back needing packs', () => {
  it('⛔ a refused run comes back as a result the model reads, told of the link; the owner’s row keeps the refusal’s words', async () => {
    const offers = vi.fn(async () => [DOCLING]);
    const result = await wrapped(REFUSAL, { offers }).dispatch('recipe.run', { recipe_id: 'parse-a-pdf' }, ctx);
    expect(offers).toHaveBeenCalledWith(['recued-core.docling']);
    const refusal = REFUSAL.ok ? '' : REFUSAL.detail;
    expect(result).toEqual({
      ok: true,
      result: { status: 'needs_pack', message: refusal, hint: neededPacksSentence([DOCLING]) },
      // What the activity row shows (D-182): the refusal, never the model's sentence.
      run_failed: { detail: refusal },
      missing_packs: ['recued-core.docling'],
      install_offers: [DOCLING],
    });
  });

  it('a refusal that wrote a run keeps its address', async () => {
    const result = await wrapped({ ...REFUSAL, run_id: 'run-1', dish_id: 'dish-1' }).dispatch('recipe.run', {}, ctx);
    expect(result).toMatchObject({ ok: true, run_id: 'run-1', dish_id: 'dish-1' });
  });

  it('a document with no reader pack carries them too, told in its hint', async () => {
    const needsPack: ChatDispatchResult = {
      ok: true,
      result: { status: 'needs_pack', suggested_packs: ['markitdown', 'docling'], hint: 'Enable a document reader pack.' },
      missing_packs: ['recued-core.markitdown', 'recued-core.docling'],
    };
    const result = await wrapped(needsPack, { offers: async () => [MARKITDOWN, DOCLING] })
      .dispatch('document.read', { file_ref: 'file:x' }, ctx);
    expect(result).toEqual({
      ...needsPack,
      result: {
        status: 'needs_pack',
        suggested_packs: ['markitdown', 'docling'],
        hint: `Enable a document reader pack. ${neededPacksSentence([MARKITDOWN, DOCLING])}`,
      },
      install_offers: [MARKITDOWN, DOCLING],
    });
  });

  it('⛔ a turn the owner does not govern gets none: the guard that refuses it tools.search', async () => {
    const offers = vi.fn(async () => [DOCLING]);
    const guard = () => { throw new Error('chat catalog: the owner tool catalog is not servable to a contracted source'); };
    const result = await wrapped(REFUSAL, { offers, guard }).dispatch('recipe.run', {}, ctx);
    expect(result).toBe(REFUSAL);
    expect(offers).not.toHaveBeenCalled();
  });

  it('a call that needed nothing, or whose packs have no offer, comes back as it was', async () => {
    const ran: ChatDispatchResult = { ok: true, result: { success: true } };
    const offers = vi.fn(async () => [DOCLING]);
    expect(await wrapped(ran, { offers }).dispatch('recipe.run', {}, ctx)).toBe(ran);
    const other: ChatDispatchResult = { ok: false, reason: 'execution_error', detail: 'engine boom' };
    expect(await wrapped(other, { offers }).dispatch('recipe.run', {}, ctx)).toBe(other);
    expect(offers).not.toHaveBeenCalled();
    expect(await wrapped(REFUSAL, { offers: async () => [] }).dispatch('recipe.run', {}, ctx)).toBe(REFUSAL);
  });

  it('a lookup that fails leaves the call’s answer as it was', async () => {
    const result = await wrapped(REFUSAL, { offers: async () => { throw new Error('offline'); } }).dispatch('recipe.run', {}, ctx);
    expect(result).toBe(REFUSAL);
  });

  it('a result the model could not be told in gets no offers', async () => {
    const bare: ChatDispatchResult = { ok: true, result: 'text', missing_packs: ['recued-core.docling'] };
    expect(await wrapped(bare).dispatch('document.read', {}, ctx)).toBe(bare);
  });

  it('with no catalogue on the server, the registry is the one it wraps', () => {
    const inner = registryAnswering(REFUSAL);
    expect(wrapRegistryWithNeededPackOffers(inner, undefined)).toBe(inner);
    const outer = wrapped(REFUSAL);
    expect(outer.list()).toEqual([TOOL]);
    expect(outer.getByName('recipe.run')).toBe(TOOL);
  });
});
