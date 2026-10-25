import { describe, expect, it } from 'vitest';
import type { Asset } from '@recued/contracts';
import { situationAssetDetails, SITUATION_ASSET_DETAILS_MAX_BYTES, SITUATION_ASSET_TEXT_MAX } from '../situations/asset-details.js';

type Fields = Pick<Asset, 'class_id' | 'status' | 'dates' | 'readings' | 'settings' | 'attributes'>;
const asset = (patch: Partial<Fields> = {}): Fields => ({ status: 'active', dates: {}, readings: {}, settings: {}, attributes: {}, ...patch });

describe('D-325 an asset’s own fields on its situation items', () => {
  it('shows each kind of field as the asset holds it, and no removed attribute', () => {
    expect(situationAssetDetails(asset({ class_id: 'vehicle', status: 'lent', dates: { legal_check_on: '2027-03-01', last_serviced_on: null },
      readings: { odometer: { value: 48_210, unit: 'km', as_of: 1, evidence: [{ collection: 'file', id: 'photo' }] }, battery: null },
      settings: { nationality: 'CN', reminders_muted: false }, attributes: { colour: 'Blue', seats: 5, removed: null } }))).toEqual({
      class_id: 'vehicle', status: 'lent', dates: { legal_check_on: '2027-03-01', last_serviced_on: null },
      readings: { odometer: { value: 48_210, unit: 'km', as_of: 1 }, battery: null },
      settings: { nationality: 'CN', reminders_muted: false }, attributes: { colour: 'Blue', seats: 5 },
    });
  });
  it('says how much a long text lost, and names a structured value it leaves out', () => {
    const long = 'é'.repeat(SITUATION_ASSET_TEXT_MAX + 34);
    const details = situationAssetDetails(asset({ attributes: { notes: long, document_details: { file: { purpose: 'Warranty' } } } }));
    expect(details.attributes).toEqual({ notes: `${'é'.repeat(SITUATION_ASSET_TEXT_MAX)}… (34 more characters)` });
    expect(details.left_out).toEqual(['attributes.document_details']);
  });
  it('stays within its cap, keeps a smaller field after one that did not fit, and names at most five it left out', () => {
    const notes = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`note_${index}`, 'x'.repeat(150)]));
    const details = situationAssetDetails(asset({ attributes: { ...notes, colour: 'Red' } }));
    const { left_out: left, ...shown } = details;
    expect(Buffer.byteLength(JSON.stringify(shown), 'utf8')).toBeLessThanOrEqual(SITUATION_ASSET_DETAILS_MAX_BYTES);
    expect(details.attributes).toMatchObject({ colour: 'Red' });
    const kept = Object.keys(details.attributes!).length - 1;
    expect(kept).toBeGreaterThan(0); expect(kept).toBeLessThan(7);
    expect(left).toEqual([...Array.from({ length: 5 }, (_, index) => `attributes.note_${kept + index}`), `+${12 - kept - 5} more`]);
  });
});
