/** D-325 — a contact book's dates reach the owner's occasions: Google's anniversary
 *  (an `events` entry) and Outlook's birthday (a UTC timestamp), each through its
 *  SHIPPED declaration, the real runner and the real store. The leaves' own tests
 *  stop at the leaf, and the runner verifies every record against what the
 *  declaration promises, so this is the path a sync actually takes. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getContactSourceDeclaration, type ContactSourceDeclaration } from '@recued/contracts';

// The gated catalog dispatch is the seam: everything after the vendor's reply runs.
const runSourceMirrorFetch = vi.fn();
vi.mock('../source-mirror/fetch.js', () => ({
  runSourceMirrorFetch: (...args: unknown[]) => runSourceMirrorFetch(...args),
}));

const { createGooglePeopleLeaf } = await import('../contact-source-adapters/google-people-leaf.js');
const { createGraphPeopleLeaf } = await import('../contact-source-adapters/graph-people-leaf.js');
const { runContactSourceSync } = await import('../contact-source-sync.js');
const { createContactStore } = await import('../storage/contact-store.js');
const { createContactSourceSyncStateStore, ensureContactSourceSyncStateSchema } = await import('../storage/contact-source-sync-state.js');
const { declaredOccasions } = await import('../situations/declared-occasions.js');

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-325-source-dates-'));
  db = new Database(join(dir, 'test.db'));
  ensureContactSourceSyncStateSchema(db);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const vendorReplies = (records: readonly Record<string, unknown>[], idField: string): void => {
  runSourceMirrorFetch.mockResolvedValue({
    ok: true, records: new Map(records.map((record) => [String(record[idField]), record])),
    truncated: false, complete: true, skipped_no_id: 0,
  });
};
const leafDeps = (catalog_slug: string, operation: string, result_path: string) => ({
  fetchDeps: {
    profiles: { get: () => ({ catalog_slug }) },
    executorConfig: { manifests: { get: () => ({ operations: { [operation]: { result_path } } }) } },
  },
  now: () => 5_000,
}) as never;

const sync = async (vendor: 'google' | 'microsoft', listContacts: Parameters<typeof runContactSourceSync>[0]['listContacts']) => {
  const store = createContactStore(db);
  const out = await runContactSourceSync(
    { store, listContacts, syncState: createContactSourceSyncStateStore(db), now: () => 5_000 },
    { source_id: `${vendor}.personal.contact`, connection_name: 'personal',
      declaration: getContactSourceDeclaration(vendor) as ContactSourceDeclaration },
  );
  return { store, out };
};
const occasionsOf = (store: ReturnType<typeof createContactStore>) =>
  declaredOccasions({ contacts: store, calendars: () => [], timeZone: () => 'UTC' })
    .map(({ class_id, month_day, title }) => ({ class_id, month_day, title }));

describe('D-325 — a contact book’s dates become occasions', () => {
  it('Google: the anniversary from `events`, beside the yearless birthday', async () => {
    vendorReplies([{
      resourceName: 'people/c1',
      names: [{ displayName: 'Ana Silva' }],
      emailAddresses: [{ value: 'ana@example.com' }],
      birthdays: [{ date: { month: 3, day: 4 } }],
      events: [
        { type: 'anniversary', date: { year: 2004, month: 6, day: 15 } },
        { type: 'Graduation', date: { year: 2015, month: 6, day: 1 } },
      ],
      metadata: { sources: [{ updateTime: '2026-07-01T00:00:00Z' }] },
    }], 'resourceName');
    const { store, out } = await sync('google', createGooglePeopleLeaf(leafDeps('google-contacts', 'contact.connections.list', 'connections')));
    expect(out.ok).toBe(true);
    expect(store.get('ana@example.com')).toMatchObject({ birthday: '--03-04', anniversary: '2004-06-15' });
    expect(occasionsOf(store)).toEqual([
      { class_id: 'birthday', month_day: '03-04', title: 'Ana Silva · birthday' },
      { class_id: 'anniversary', month_day: '06-15', title: 'Ana Silva · anniversary' },
    ]);
  });

  it('Outlook: the birthday Outlook meant, from a stored local midnight', async () => {
    vendorReplies([{
      id: 'AAMk-1',
      displayName: 'Ben Okafor',
      emailAddresses: [{ address: 'ben@example.com' }],
      // 2 April, entered in Berlin.
      birthday: '1980-04-01T23:00:00Z',
      lastModifiedDateTime: '2026-07-01T00:00:00Z',
    }], 'id');
    const { store, out } = await sync('microsoft', createGraphPeopleLeaf(leafDeps('microsoft-contacts', 'contact.list', 'value')));
    expect(out.ok).toBe(true);
    expect(store.get('ben@example.com')?.birthday).toBe('1980-04-02');
    expect(occasionsOf(store)).toEqual([{ class_id: 'birthday', month_day: '04-02', title: 'Ben Okafor · birthday' }]);
  });
});
