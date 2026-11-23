/** D-405 — whether any mailbox, calendar or file source is connected: ONE fact for the chat's hints
 *  ("No mailbox is connected yet", slice 2) and the Set up page (slice 4), so the two never disagree.
 *
 *  What the Connections page lists: a row of its own (`collection_instances`), in whatever state, so one
 *  that needs reconnecting is connected.
 *  ⛔ Not the calendar every server makes for itself at boot (`local`, D-173 P4.3): it is Recued's own,
 *  not the owner's, and holds only the events added in Recued.
 *  ⛔ A file source is a folder or a cloud source (the Files lane lists both): an API connection to a
 *  vendor that serves files. Unknown without the connection store, and unknown is never "none". */
import type Database from 'better-sqlite3';
import { getFileVendorDeclaration, type ChatSetupFeature } from '@recued/contracts';

import { DEFAULT_LOCAL_CALENDAR_SLUG } from '../collections/calendar/local-provider.js';
import { createInstanceStore, type CollectionInstanceStore } from '../collections/instance-store.js';
import type { ConnectionStoreSqlite } from '../storage/connection-store.js';
import { connectionVendorOf } from '../work-entity-source-boot.js';

export interface SetupFeatureFactsDeps {
  readonly db: Database.Database;
  readonly getConnectionStore: () => ConnectionStoreSqlite | undefined;
}

/** True or false, or null when it cannot be known. */
export type SetupFeatureConnected = (feature: ChatSetupFeature) => boolean | null;

export const createSetupFeatureFacts = (deps: SetupFeatureFactsDeps): SetupFeatureConnected => {
  // Opened at first use: a store creates its table when it opens.
  let instances: CollectionInstanceStore | undefined;
  return (feature) => {
    const rows = (instances ??= createInstanceStore({ db: deps.db })).list(feature)
      .filter((row) => !(feature === 'calendar' && row.adapter_type === 'local' && row.slug === DEFAULT_LOCAL_CALENDAR_SLUG));
    if (rows.length > 0 || feature !== 'file') return rows.length > 0;
    const connections = deps.getConnectionStore();
    if (connections === undefined) return null;
    return connections.list({ kind: 'api' }).some((row) => {
      const vendor = connectionVendorOf(row);
      return vendor !== null && getFileVendorDeclaration(vendor) !== null;
    });
  };
};
