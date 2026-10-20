import { describe, expect, it } from 'vitest';
import { ASSET_SOURCE_RANKS, type Asset, type AssetContributionKind, type AssetPatch } from '@recued/contracts';
import { assetEvidenceText, assetSourceWords, changedAssetPatch } from '../yours/asset-provenance.js';

// D-325 §15.3 — the asset page says where each fact came from and what can replace it.
describe('D-325 asset provenance in the owner’s words', () => {
  const own: Partial<Asset> = { name: 'Passport', status: 'active', holder_contact: 'ana', class_id: 'passport',
    dates: { expires_on: '2031-05-12', issued_on: null }, attributes: { cover: 'Blue' },
    settings: { radius_km: 5, expected_patterns: { flickering: { active: true, at: 1 } } },
    values: [{ amount: '10', currency: 'EUR', as_of: 1, basis: 'purchase', evidence: [] }], anchors: [] };
  // What the edit dialog builds: every field it shows, here with one change.
  const full: AssetPatch = { name: 'Passport (old)', status: 'active', holder_contact: 'ana', sphere_override: null, class_id: 'passport',
    dates: { expires_on: '2031-05-12', issued_on: null }, attributes: { cover: 'Blue' },
    settings: { radius_km: 5, expected_patterns: { flickering: { at: 1, active: true } } },
    document_number: null, serial_number: null, exact_address: null,
    values: [{ amount: '10', currency: 'EUR', as_of: 1, basis: 'purchase', evidence: [] }], anchors: [] };

  it('sends only what an edit changed, so an untouched value keeps its source', () => {
    expect(changedAssetPatch(full, own)).toEqual({ name: 'Passport (old)' });
    expect(changedAssetPatch({ ...full, dates: { expires_on: '2032-01-01', issued_on: null }, settings: { radius_km: null } }, own))
      .toEqual({ name: 'Passport (old)', dates: { expires_on: '2032-01-01' }, settings: { radius_km: null } });
    expect(changedAssetPatch({ holder_contact: null, anchors: [{ kind: 'place', name: 'Home' }], dates: { inspected_on: null } }, own))
      .toEqual({ holder_contact: null, anchors: [{ kind: 'place', name: 'Home' }] });
  });

  it('says what outranks each source, true of every rank', () => {
    const phrase: Partial<Record<AssetContributionKind, string>> = {
      owner: 'your own entry', confirmed_document: 'a document you confirm', observation: 'a device report' };
    const source = (kind: AssetContributionKind) => ({ kind, ref: 'x', at: Date.parse('2026-10-17T12:00Z') });
    for (const kind of Object.keys(ASSET_SOURCE_RANKS) as AssetContributionKind[]) {
      const { rank } = assetSourceWords(source(kind));
      const higher = (Object.keys(phrase) as AssetContributionKind[]).filter(other => ASSET_SOURCE_RANKS[other] > ASSET_SOURCE_RANKS[kind]);
      if (kind === 'owner') expect(rank).toBe('Nothing automatic replaces it.');
      else if (kind === 'ai_guess') expect(rank).toBe('Anything else outranks it.');
      else for (const other of Object.keys(phrase) as AssetContributionKind[]) {
        expect(rank.toLowerCase().includes(phrase[other]!), `${kind} names ${other}`).toBe(higher.includes(other));
      }
    }
    expect(assetSourceWords({ ...source('extracted'), ref: 'reception:request-1' }).from).toMatch(/^From a request that came in, /u);
    expect(assetSourceWords(source('confirmed_document')).from).toMatch(/^From a document you confirmed, /u);
  });

  it('says what each piece of evidence showed, by where it is', () => {
    expect(assetEvidenceText({ collection: 'home-assistant', id: 'light.porch', field: 'transitions', value: 'on and off 14 times' }))
      .toBe('Home Assistant · light.porch · transitions: on and off 14 times');
    expect(assetEvidenceText({ collection: 'file', id: 'file-1', field: 'dates.expires_on', value: '2031-05-12' })).toBe('Document · expires on: 2031-05-12');
    expect(assetEvidenceText({ collection: 'paperless-x', id: 'doc-1' })).toBe('paperless-x · doc-1');
  });
});
