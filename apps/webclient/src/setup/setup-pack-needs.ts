/** D-405 slice 4 — what each installed pack still needs, for the Set up page: the reads the Packs page
 *  makes, put together by its own rule (`packNeedsOf`), so "Needs attention" there and the packs here are
 *  one list. Said again each time a read lands: a program's status can take a probe's whole limit, and the
 *  page shows what it has meanwhile.
 *
 *  ⛔ A read that fails adds nothing ("Needs update", a program, a connection): never a false need, as on
 *  the Packs page. Only the roster itself failing is said, since without it nothing is known. */
import type { PacksToolStatusResult } from '@recued/contracts';

import {
  connectionNeedsOf,
  packNeedsOf,
  thingsMissingOf,
  usesMissingOf,
  type ConnectionNeeds,
  type PackInstalledListCaller,
  type PackNeed,
  type RosterPack,
} from '../discover/pack-discovery.js';
import type { ConnectionsReadinessListCaller } from '../settings/connections-readiness-controls.js';
import type { PackConnectionsCallers } from '../settings/pack-connections-controls.js';

/** The reads, as the Packs page is handed them. Only the roster is required. */
export interface PackNeedsReads {
  readonly listInstalled: PackInstalledListCaller;
  readonly listUnrunnable?: () => Promise<{ findings: ReadonlyArray<{ slug: string }> }>;
  readonly listToolStatus?: () => Promise<PacksToolStatusResult>;
  readonly listConnections?: ConnectionsReadinessListCaller;
  readonly listSignIns?: PackConnectionsCallers['signins'];
}

/** How many packs are installed, and what those that need something need. */
export interface PackNeedsView {
  readonly installed: number;
  readonly needs: readonly PackNeed[];
}

/** Calls `onView` once the roster is read and again as each other read lands; with null when the roster
 *  cannot be read. Returns the way to stop. */
export const watchPackNeeds = (reads: PackNeedsReads, onView: (view: PackNeedsView | null) => void): (() => void) => {
  let stopped = false;
  let roster: ReadonlyArray<RosterPack> | null = null;
  let unrunnable: ReadonlySet<string> = new Set();
  let programs: ReadonlyMap<string, PacksToolStatusResult['packs'][number]['tools']> = new Map();
  let connections: ReadonlyMap<string, ConnectionNeeds> = new Map();
  const emit = (): void => {
    if (stopped || roster === null) return;
    const installed = roster.filter((pack) => pack.installed || pack.installed_any_version === true).length;
    onView({
      installed,
      needs: packNeedsOf(roster, {
        unrunnable,
        programs,
        connections,
        usesMissing: usesMissingOf(roster),
        thingsMissing: thingsMissingOf(roster),
      }),
    });
  };
  void reads.listInstalled().then(
    (answer) => {
      // An answer with no roster in it is one that could not be read, never "no packs".
      if (!Array.isArray(answer?.packs)) {
        if (!stopped) onView(null);
        return;
      }
      roster = answer.packs;
      emit();
      // A connection's need is per installed pack, so it is read once the roster is.
      const list = reads.listConnections;
      if (list === undefined) return;
      const signins = reads.listSignIns?.().then((view) => view.signins, () => null) ?? Promise.resolve(null);
      void Promise.all([list(), signins]).then(
        ([answer, lists]) => {
          if (roster === null || !Array.isArray(answer?.connections)) return;
          connections = connectionNeedsOf(roster, answer.connections, lists);
          emit();
        },
        () => { /* no connection need, never a false one */ },
      );
    },
    () => { if (!stopped) onView(null); },
  );
  void reads.listUnrunnable?.().then(
    (res) => {
      if (!Array.isArray(res?.findings)) return;
      unrunnable = new Set(res.findings.map((finding) => finding.slug));
      emit();
    },
    () => { /* no "Needs update", never a false one */ },
  );
  void reads.listToolStatus?.().then(
    (res) => {
      if (!Array.isArray(res?.packs)) return;
      programs = new Map(res.packs.map((entry) => [entry.slug, entry.tools]));
      emit();
    },
    () => { /* no program need, never a false one */ },
  );
  return () => { stopped = true; };
};
