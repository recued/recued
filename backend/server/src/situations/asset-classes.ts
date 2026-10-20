import type Database from 'better-sqlite3';
import { validateAssetClassPreset, type Asset, type AssetClassPreset, type AssetRule } from '@recued/contracts';

const expiry = (id: string, title: string, field: string, floor: boolean, before: AssetRule['schedule']['before'], notice = false): AssetRule => ({
  id, title, enabled: true, muted: false, pinned: false, when: { kind: 'expiry', field }, consequence: floor ? 'floor' : 'routine',
  expiry_policy: floor ? 'escalate_overdue' : 'strict_expire', reaction: { notify: true, occurrence: notice ? 'notice' : 'action', emit: false },
  // P47 — a routine clock lapses on its due day (`strict_expire`), so only a floor
  // clock, which stays overdue, has repeats to send.
  schedule: { before, on_day: true, ...(!notice && floor ? { after: { amount: 1, unit: 'months' as const } } : {}) },
});
const month = (amount: number) => ({ amount, unit: 'months' as const });
const notice = (floor: boolean): AssetRule => ({ ...expiry('notice', 'Cancel or renew before notice ends', 'renews_on', floor, [month(1)]),
  when: { kind: 'expiry', field: 'renews_on', offset: month(1) } });
const condition = (id: string, title: string, field: string, floor: boolean, notice = false): AssetRule => ({
  ...expiry(id, title, field, floor, [], notice), when: { kind: 'condition', field, certainty: 'conditional' },
});
const interval = (title: string, field: string, floor: boolean): AssetRule => ({ ...expiry('service', title, field, floor, [month(1)]),
  when: { kind: 'interval', field, every: { amount: 12, unit: 'months' } } });
const preset = (id: string, name: string, dates: string[], rules: AssetRule[], patch: Partial<AssetClassPreset> = {}): AssetClassPreset => ({
  id, name, version: 1, origin: 'builtin', fields: { dates: Object.fromEntries(dates.map(field => [field, null])),
    readings: {}, observations: {}, settings: {} }, rules, audience: 'owner', retirement: 'part', ...patch,
});
/** These presets supply clocks, never facts. Unknown anchors remain null. Packs
 * may add versioned classes without extending the asset kind or rule grammar. */
export const STARTER_ASSET_CLASSES: readonly AssetClassPreset[] = [
  ...[['passport', 'Passport', [month(6), month(3), month(1)]], ['id_card', 'ID card', [month(3), month(1)]],
    ['visa', 'Visa', [month(3), month(1)]], ['driving_licence', 'Driving licence', [month(3), month(1)]]] .map(([id, name, before]) =>
    preset(id as string, name as string, ['expires_on', 'issued_on'], [expiry('renew', 'Renew', 'expires_on', true, before as AssetRule['schedule']['before'])],
      { fields: { dates: { expires_on: null, issued_on: null }, readings: {}, observations: {}, settings: { sensitive: true } } })),
  // §4.13 — the key rule is the notice deadline: the renewal date minus the notice
  // period (a month until the owner edits it). A renewal moves both; v1 typed it.
  preset('insurance_policy', 'Insurance policy', ['renews_on'], [expiry('renew', 'Review cover', 'renews_on', true, [month(1)]),
    notice(true)], { version: 2, retirement: 'cancel_or_transfer' }),
  preset('service_contract', 'Service contract', ['renews_on'], [expiry('renew', 'Review contract', 'renews_on', false, [month(1)]),
    notice(false)], { version: 2, retirement: 'cancel_or_transfer' }),
  preset('vehicle', 'Vehicle', ['legal_check_on', 'last_serviced_on'], [expiry('legal_check', 'Book legal check', 'legal_check_on', true, [month(1)]),
    interval('Service', 'last_serviced_on', false), condition('recall', 'Check vehicle recall', 'open_recall', true)], { version: 2, audience: 'household', fields: { dates: { legal_check_on: null, last_serviced_on: null },
    readings: { odometer: null }, observations: { open_recall: null }, settings: {} } }),
  preset('boiler', 'Boiler', ['last_serviced_on'], [interval('Service boiler', 'last_serviced_on', true)], { audience: 'household' }),
  preset('smoke_alarm', 'Smoke or CO alarm', ['last_tested_on'], [interval('Test alarm', 'last_tested_on', true), condition('battery', 'Replace alarm battery', 'battery_low', true)], { audience: 'household',
    fields: { dates: { last_tested_on: null }, readings: { battery: null }, observations: { battery_low: null }, settings: {} } }),
  preset('warranty_purchase', 'Warranty-bearing purchase', ['warranty_ends_on'], [expiry('warranty', 'Warranty ends', 'warranty_ends_on', false, [month(1)], true)]),
  preset('home', 'Home', [], [condition('hazard', 'Check nearby hazard', 'fire_nearby', true, true)], { audience: 'household', fields: { dates: {}, readings: {}, observations: { fire_nearby: null }, settings: { hazard_radius_km: 5 } } }),
  preset('holding', 'Holding', [], [condition('price_move', 'Review price movement', 'price_move', false, true)], { fields: { dates: {}, readings: {}, observations: { price_move: null }, settings: {} } }),
  preset('heirloom', 'Heirloom or keepsake', [], []),
];

export const validateAssetClass = validateAssetClassPreset;
export const createAssetClassStore = (db: Database.Database) => {
  db.exec('CREATE TABLE IF NOT EXISTS asset_class_presets (id TEXT PRIMARY KEY, version INTEGER NOT NULL, origin TEXT NOT NULL, value TEXT NOT NULL)');
  const get = (id: string): AssetClassPreset | null => {
    const row = db.prepare('SELECT value FROM asset_class_presets WHERE id=?').get(id) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  };
  const register = (value: AssetClassPreset): boolean => {
    validateAssetClass(value); const old = get(value.id);
    if (old && old.origin !== value.origin) throw new Error('The class belongs to a different source');
    if (old && old.version >= value.version) return false;
    db.prepare('INSERT INTO asset_class_presets(id,version,origin,value) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,value=excluded.value')
      .run(value.id, value.version, value.origin, JSON.stringify(value)); return true;
  };
  for (const item of STARTER_ASSET_CLASSES) register(item);
  return {
    get, register,
    syncPack(publisher: string, slug: string, presets: readonly AssetClassPreset[]): void {
      const origin = `pack:${publisher}/${slug}`;
      const ids = new Set<string>();
      for (const item of presets) {
        validateAssetClass(item);
        if (item.origin !== origin || ids.has(item.id)) throw new Error('The class must uniquely belong to its shipping pack');
        const old = get(item.id);
        if (old && old.origin !== origin) throw new Error('The class belongs to a different source');
        if (old && old.version === item.version && JSON.stringify(old) !== JSON.stringify(item)) throw new Error('Changed class content needs a new version');
        ids.add(item.id);
      }
      db.transaction(() => {
        for (const item of presets) register(item);
        for (const row of db.prepare('SELECT id FROM asset_class_presets WHERE origin=?').all(origin) as { id: string }[]) {
          if (!ids.has(row.id)) db.prepare('DELETE FROM asset_class_presets WHERE id=?').run(row.id);
        }
      })();
    },
    removePack(slug: string): void {
      for (const row of db.prepare('SELECT id,origin FROM asset_class_presets').all() as { id: string; origin: string }[]) {
        if (row.origin.startsWith('pack:') && row.origin.slice(row.origin.indexOf('/') + 1) === slug) db.prepare('DELETE FROM asset_class_presets WHERE id=?').run(row.id);
      }
    },
    list: (): AssetClassPreset[] => (db.prepare('SELECT value FROM asset_class_presets ORDER BY id').all() as { value: string }[]).map(row => JSON.parse(row.value)),
    saveOwner(value: AssetClassPreset): void {
      if (value.origin !== 'owner') throw new Error('Save an owner copy to edit a pack class');
      const old = get(value.id);
      if (old?.origin && old.origin !== 'owner') throw new Error('Choose a new id for your copy');
      register({ ...value, version: (old?.version ?? 0) + 1 });
    },
    deleteOwner(id: string): void {
      if (get(id)?.origin !== 'owner') throw new Error('Only an owner class can be removed');
      db.prepare('DELETE FROM asset_class_presets WHERE id=?').run(id);
    },
  };
};
export type AssetClassStore = ReturnType<typeof createAssetClassStore>;

/** New assets receive the preset first; every explicit owner value wins. On a
 * later update the caller only applies rows the owner has not pinned. */
export const assetClassPatch = (value: AssetClassPreset, own: Partial<Asset> = {}) => ({
  class_id: value.id, audience: own.audience ?? value.audience,
  // P28 — a pinned placement stays the owner's pin; it never becomes the derived sphere.
  ...(own.sphere ?? value.sphere ? { sphere: own.sphere ?? value.sphere } : {}),
  retirement: own.retirement ?? value.retirement,
  dates: { ...value.fields.dates, ...own.dates }, readings: { ...value.fields.readings, ...own.readings },
  observations: { ...value.fields.observations, ...own.observations }, settings: { ...value.fields.settings, ...own.settings,
    class_version: value.version, class_rule_ids: value.rules.map(rule => rule.id) },
  rules: [...value.rules.map(rule => own.rules?.find(row => row.id === rule.id) ?? structuredClone(rule)),
    ...(own.rules?.filter(rule => !value.rules.some(row => row.id === rule.id)) ?? [])],
});
