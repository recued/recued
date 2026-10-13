/** D-323 — the offers a turn's answer carries: the packs its calls came back
 *  needing, then its LAST `tools.search`'s. */

import { describe, expect, it } from 'vitest';

import { installOffersFromToolResults } from '../turn-offers.js';

const OFFER = { kind: 'pack', slug: 'rental-book', name: 'Rental Book', publisher: 'recued-core', recipes: ['Collect the rent'] };
const search = (installable?: unknown, ok = true) => ({
  tool_name: 'tools.search',
  result: ok ? { ok: true, result: { match_count: 0, matches: [], ...(installable !== undefined ? { installable } : {}) } } : { ok: false, reason: 'invalid_args' },
});

describe('the offers on a turn’s answer', () => {
  it('are the ones its search returned', () => {
    expect(installOffersFromToolResults([search([OFFER])])).toEqual([OFFER]);
  });

  it('⛔ come from the LAST search: a later search that found something installed clears them', () => {
    expect(installOffersFromToolResults([search([OFFER]), { tool_name: 'contact.search', result: { ok: true } }]))
      .toEqual([OFFER]);
    expect(installOffersFromToolResults([search([OFFER]), search()])).toEqual([]);
  });

  it('none from a failed search, a turn with no search, or a malformed list', () => {
    expect(installOffersFromToolResults([search([OFFER], false)])).toEqual([]);
    expect(installOffersFromToolResults([{ tool_name: 'recipe.run', result: { ok: true, result: { installable: [OFFER] } } }]))
      .toEqual([]);
    expect(installOffersFromToolResults(undefined)).toEqual([]);
    expect(installOffersFromToolResults([search([{ ...OFFER, slug: '../x' }, 'nope'])])).toEqual([]);
  });
});

const DOCLING = { kind: 'pack', slug: 'docling', name: 'Docling', publisher: 'recued-core', recipes: [] };
const WHISPER = { kind: 'pack', slug: 'whisper', name: 'Whisper', publisher: 'recued-core', recipes: [] };
/** A run refused for packs not installed, as the chat registry returns it with
 *  its offers (`needed-packs.ts`). */
const refused = (install_offers: unknown[]) => ({
  tool_name: 'recued-core/parse-a-pdf',
  result: {
    ok: true,
    result: { status: 'needs_pack', message: '…', hint: '…' },
    run_failed: { detail: '…' },
    missing_packs: ['recued-core.docling'],
    install_offers,
  },
});

describe('the offers on the answer to a turn whose call needed a pack', () => {
  it('are the packs it needed, from a refused run or a document with no reader', () => {
    expect(installOffersFromToolResults([refused([DOCLING])])).toEqual([DOCLING]);
    expect(installOffersFromToolResults([{
      tool_name: 'document.read',
      result: { ok: true, result: { status: 'needs_pack' }, install_offers: [DOCLING] },
    }])).toEqual([DOCLING]);
  });

  it('🔑 come before the last search’s, and a later search does not clear them', () => {
    expect(installOffersFromToolResults([refused([DOCLING]), search([OFFER])])).toEqual([DOCLING, OFFER]);
    expect(installOffersFromToolResults([search([OFFER]), refused([DOCLING])])).toEqual([DOCLING, OFFER]);
    expect(installOffersFromToolResults([refused([DOCLING]), search()])).toEqual([DOCLING]);
  });

  it('are each once, and three at most, a duplicate not counting toward the three', () => {
    const FFMPEG = { ...DOCLING, slug: 'ffmpeg', name: 'FFmpeg' };
    expect(installOffersFromToolResults([refused([DOCLING]), refused([DOCLING, WHISPER]), search([DOCLING, FFMPEG, OFFER])]))
      .toEqual([DOCLING, WHISPER, FFMPEG]);
  });

  it('⛔ never come from inside what the model reads: only the host’s field beside it', () => {
    expect(installOffersFromToolResults([{
      tool_name: 'recued-core/parse-a-pdf',
      result: { ok: true, result: { install_offers: [DOCLING] } },
    }])).toEqual([]);
    expect(installOffersFromToolResults([refused([{ ...DOCLING, slug: 'javascript:alert(1)' }])])).toEqual([]);
  });
});
