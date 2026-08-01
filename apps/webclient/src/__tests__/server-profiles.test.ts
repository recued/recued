/** Server-profile roster algebra — the shape that makes "connect to a
 *  different server" possible without clearing site data.
 *
 *  Pure functions over `{ profiles, activeId }`, so the switch semantics are
 *  tested without IndexedDB, crypto, or a socket. The cases that matter are
 *  the ones where a naive implementation strands the user: a dangling active
 *  pointer, removing the profile you are on, re-pairing a server you already
 *  know.
 */

import { describe, expect, it } from 'vitest';
import type { WebclientLocalStorage, WebclientServerProfile } from '@recued/contracts';
import {
  EMPTY_ROSTER,
  activeProfile,
  beginPendingProfile,
  blankProfile,
  defaultProfileLabel,
  connectableProfiles,
  ensureActiveProfileFor,
  isPendingProfile,
  migrateLegacyFields,
  noteConnected,
  projectProfile,
  removeProfile,
  renameProfile,
  setActiveField,
  switchTo,
  type ProfileRoster,
} from '../storage/server-profiles.js';

let n = 0;
const mintId = (): string => `p${++n}`;
const resetIds = (): void => { n = 0; };

const roster = (...urls: string[]): ProfileRoster => {
  resetIds();
  let r = EMPTY_ROSTER;
  for (const u of urls) r = ensureActiveProfileFor(r, u, mintId);
  return r;
};

const HOME = 'wss://home.example:8443/ws';
const OFFICE = 'wss://office.example:8443/ws';

describe('defaultProfileLabel', () => {
  it('uses host + port, and never throws on an unparseable value', () => {
    expect(defaultProfileLabel(HOME)).toBe('home.example:8443');
    expect(defaultProfileLabel('wss://plain.example/ws')).toBe('plain.example');
    // A label is cosmetic; a parse failure must not take down the switcher.
    expect(defaultProfileLabel('not a url')).toBe('not a url');
  });
});

describe('projectProfile', () => {
  it('projects the five logical fields', () => {
    const p = blankProfile('p1', HOME);
    expect(projectProfile({ ...p, server_public_key: 'spki' })).toEqual({
      server_url: HOME,
      webclient_token: null,
      server_public_key: 'spki',
      pair_metadata: null,
      cert_pin_state: null,
    });
  });

  it('reads all-null with no active profile — the unpaired shape callers already handle', () => {
    // The whole point of the compatibility layer: 70-odd existing readers do
    // `get('server_url')` and branch on null. Projecting "no profile" to
    // anything else would need every one of them to learn a new state.
    expect(projectProfile(null)).toEqual({
      server_url: null,
      webclient_token: null,
      server_public_key: null,
      pair_metadata: null,
      cert_pin_state: null,
    });
  });
});

describe('activeProfile', () => {
  it('resolves the active record', () => {
    const r = roster(HOME, OFFICE);
    expect(activeProfile(r)?.server_url).toBe(OFFICE);
  });

  it('reads null on a DANGLING pointer, and does not mutate to heal it', () => {
    // A roster whose activeId names a profile that is gone (an interrupted
    // remove, a hand-edited store). Reading must not repair — a getter that
    // writes turns an inspection into a state change.
    const r = { ...roster(HOME), activeId: 'gone' };
    expect(activeProfile(r)).toBeNull();
    expect(r.profiles).toHaveLength(1);
    expect(r.activeId).toBe('gone');
  });
});

describe('ensureActiveProfileFor', () => {
  it('adds and activates a new server', () => {
    const r = ensureActiveProfileFor(EMPTY_ROSTER, HOME, mintId);
    expect(r.profiles).toHaveLength(1);
    expect(activeProfile(r)?.server_url).toBe(HOME);
  });

  it('re-pairing a KNOWN url activates it instead of duplicating', () => {
    // Without this, every credential replacement against the same server
    // grows an identical row, and the switcher fills with copies the user
    // cannot tell apart.
    const r = roster(HOME, OFFICE);
    const again = ensureActiveProfileFor(r, HOME, mintId);
    expect(again.profiles).toHaveLength(2);
    expect(activeProfile(again)?.server_url).toBe(HOME);
  });

  it('keeps the existing profile IDENTITY on re-pair, so its label survives', () => {
    let r = roster(HOME);
    r = renameProfile(r, r.profiles[0]!.id, 'Home NAS');
    const again = ensureActiveProfileFor(r, HOME, mintId);
    expect(activeProfile(again)?.label).toBe('Home NAS');
  });

  it('keeps the hydrated active generation when a corrupt roster duplicates its URL', () => {
    const first = {
      ...blankProfile('p1', HOME),
      label: 'stale duplicate',
    };
    const hydrated = {
      ...blankProfile('p2', HOME),
      label: 'hydrated active',
    };
    const corrupted: ProfileRoster = {
      profiles: [first, hydrated],
      activeId: hydrated.id,
    };

    const next = ensureActiveProfileFor(corrupted, HOME, mintId);

    expect(next.activeId).toBe('p2');
    expect(activeProfile(next)?.label).toBe('hydrated active');
  });
});

describe('setActiveField', () => {
  it('writes only the active profile', () => {
    const r = roster(HOME, OFFICE); // OFFICE active
    const next = setActiveField(r, 'server_public_key', 'office-key');
    expect(next.profiles.find((p) => p.server_url === OFFICE)?.server_public_key).toBe('office-key');
    expect(next.profiles.find((p) => p.server_url === HOME)?.server_public_key).toBeNull();
  });

  it('opens a PENDING profile when a field is written before any URL', () => {
    // Not hypothetical, and the reason this branch exists: the cert-pin
    // watcher persists `cert_pin_state` on a browser that has never stored a
    // URL, and pairing writes metadata around the URL rather than strictly
    // after it. Dropping those writes silently is the worst thing a store can
    // do — it looked like success and lost the data. (Caught by 21 failing
    // tests when this returned the roster unchanged.)
    const r = setActiveField(EMPTY_ROSTER, 'server_public_key', 'spki', mintId);
    expect(r.profiles).toHaveLength(1);
    expect(activeProfile(r)?.server_public_key).toBe('spki');
    expect(isPendingProfile(activeProfile(r)!)).toBe(true);
  });

  it('without an id minter it stays a no-op — a pure read path cannot mint', () => {
    expect(setActiveField(EMPTY_ROSTER, 'server_public_key', 'spki')).toEqual(EMPTY_ROSTER);
  });

  it('treats a DANGLING active pointer as no profile, not as a lost write', () => {
    const r = { ...roster(HOME), activeId: 'gone' };
    const next = setActiveField(r, 'server_public_key', 'spki', mintId);
    expect(activeProfile(next)?.server_public_key).toBe('spki');
    // The original profile is untouched — the write went to a new record
    // rather than silently landing on an unrelated server.
    expect(next.profiles.find((p) => p.server_url === HOME)?.server_public_key).toBeNull();
  });
});

describe('pending profiles', () => {
  it('ensureActiveProfileFor ADOPTS the pending record when the URL arrives', () => {
    // The fields written before the URL belong to this server. Creating a
    // second profile instead would strand a half-populated ghost in the
    // roster forever — visible in the switcher, impossible to connect.
    let r = setActiveField(EMPTY_ROSTER, 'server_public_key', 'spki', mintId);
    r = ensureActiveProfileFor(r, HOME, mintId);
    expect(r.profiles).toHaveLength(1);
    const p = activeProfile(r)!;
    expect(p.server_url).toBe(HOME);
    expect(p.server_public_key).toBe('spki'); // carried, not lost
    expect(p.label).toBe('home.example:8443');
    expect(isPendingProfile(p)).toBe(false);
  });

  it('retires the pending record when the URL turns out to be one we already know', () => {
    let r = roster(HOME);            // HOME exists and is active
    r = { ...r, activeId: null };    // simulate a write with no active pointer
    r = setActiveField(r, 'server_public_key', 'stray', mintId);
    expect(r.profiles).toHaveLength(2);
    r = ensureActiveProfileFor(r, HOME, mintId);
    // Back to one row, pointed at the real HOME profile.
    expect(r.profiles).toHaveLength(1);
    expect(activeProfile(r)?.server_url).toBe(HOME);
  });

  it('a pending profile is never offered as somewhere to connect', () => {
    const r = setActiveField(EMPTY_ROSTER, 'cert_pin_state', null, mintId);
    expect(r.profiles).toHaveLength(1);
    expect(connectableProfiles(r)).toEqual([]);
  });
});

describe('switchTo', () => {
  it('moves the pointer between known profiles', () => {
    const r = roster(HOME, OFFICE);
    const home = r.profiles.find((p) => p.server_url === HOME)!;
    expect(activeProfile(switchTo(r, home.id))?.server_url).toBe(HOME);
  });

  it('ignores an unknown id instead of blanking the pointer', () => {
    // A stale switcher click (a profile removed in another tab) must not
    // strand the app with no server at all.
    const r = roster(HOME);
    expect(switchTo(r, 'nope')).toEqual(r);
  });
});

describe('removeProfile', () => {
  it('drops a non-active profile and leaves the pointer alone', () => {
    const r = roster(HOME, OFFICE); // OFFICE active
    const home = r.profiles.find((p) => p.server_url === HOME)!;
    const next = removeProfile(r, home.id);
    expect(next.profiles).toHaveLength(1);
    expect(activeProfile(next)?.server_url).toBe(OFFICE);
  });

  it('removing the ACTIVE profile falls back to the most recently connected', () => {
    let r = roster(HOME, OFFICE, 'wss://third.example/ws');
    const home = r.profiles.find((p) => p.server_url === HOME)!;
    const office = r.profiles.find((p) => p.server_url === OFFICE)!;
    r = noteConnected(r, home.id, 1_000);
    r = noteConnected(r, office.id, 5_000);
    const third = r.profiles.find((p) => p.server_url === 'wss://third.example/ws')!;
    const next = removeProfile({ ...r, activeId: third.id }, third.id);
    // OFFICE (5000) over HOME (1000) — not "whatever is first in the array".
    expect(activeProfile(next)?.server_url).toBe(OFFICE);
  });

  it('does not let corrupt recency displace a valid fallback', () => {
    let r = roster(HOME, OFFICE, 'wss://third.example/ws');
    const home = r.profiles.find((p) => p.server_url === HOME)!;
    const office = r.profiles.find((p) => p.server_url === OFFICE)!;
    const third = r.profiles.find((p) => p.server_url === 'wss://third.example/ws')!;
    r = {
      ...r,
      profiles: r.profiles.map((profile) => {
        if (profile.id === home.id) return { ...profile, last_connected_at: Number.NaN };
        if (profile.id === office.id) return { ...profile, last_connected_at: 5_000 };
        return profile;
      }),
      activeId: third.id,
    };

    expect(activeProfile(removeProfile(r, third.id))?.server_url).toBe(OFFICE);
  });

  it('removing the last profile leaves an unpaired roster', () => {
    const r = roster(HOME);
    const next = removeProfile(r, r.profiles[0]!.id);
    expect(next).toEqual({ profiles: [], activeId: null });
    // Reads as unpaired ⇒ the boot lands on the pair form, which is the
    // correct destination for a browser with no servers left.
    expect(projectProfile(activeProfile(next)).server_url).toBeNull();
  });

  it('ignores an unknown id', () => {
    const r = roster(HOME);
    expect(removeProfile(r, 'nope')).toEqual(r);
  });
});

describe('renameProfile', () => {
  it('renames, and falls back to the URL label for blank input', () => {
    let r = roster(HOME);
    const id = r.profiles[0]!.id;
    r = renameProfile(r, id, '  Home NAS  ');
    expect(r.profiles[0]!.label).toBe('Home NAS');
    r = renameProfile(r, id, '   ');
    // An empty label would render an unclickable row in the switcher.
    expect(r.profiles[0]!.label).toBe('home.example:8443');
  });
});

describe('noteConnected', () => {
  it('stamps only the named profile and keeps the active pointer unchanged', () => {
    const r = roster(HOME, OFFICE);
    const home = r.profiles.find((profile) => profile.server_url === HOME)!;
    const next = noteConnected(r, home.id, 1_700_000_000_000);

    expect(next.activeId).toBe(r.activeId);
    expect(next.profiles.find((profile) => profile.id === home.id)?.last_connected_at)
      .toBe(1_700_000_000_000);
    expect(next.profiles.find((profile) => profile.server_url === OFFICE)?.last_connected_at)
      .toBeNull();
  });

  it('refuses an invalid clock value instead of poisoning recency ordering', () => {
    const r = roster(HOME);
    expect(noteConnected(r, r.profiles[0]!.id, Number.NaN)).toBe(r);
    expect(noteConnected(r, r.profiles[0]!.id, Number.POSITIVE_INFINITY)).toBe(r);
    expect(noteConnected(r, r.profiles[0]!.id, -1)).toBe(r);
  });

  it('never moves recency backwards when a delayed sibling stamp arrives', () => {
    let r = roster(HOME);
    const id = r.profiles[0]!.id;
    r = noteConnected(r, id, 2_000);
    r = noteConnected(r, id, 1_000);
    expect(r.profiles[0]!.last_connected_at).toBe(2_000);
  });
});

describe('migrateLegacyFields', () => {
  const legacy = (over: Partial<WebclientLocalStorage> = {}): Partial<WebclientLocalStorage> => ({
    server_url: HOME,
    webclient_token: { token_id: 't1', ciphertext_b64: 'c', iv_b64: 'i', issued_at: 7 },
    server_public_key: 'spki',
    pair_metadata: null,
    cert_pin_state: null,
    ...over,
  });

  it('folds the five legacy values into one active profile, carrying the wrapped token', () => {
    const r = migrateLegacyFields(legacy(), mintId)!;
    expect(r.profiles).toHaveLength(1);
    const p = activeProfile(r)!;
    expect(p.server_url).toBe(HOME);
    expect(p.server_public_key).toBe('spki');
    // The bearer must survive the migration — dropping it would silently log
    // out every existing install on upgrade.
    expect(p.webclient_token?.token_id).toBe('t1');
  });

  it('labels the migrated profile with the paired handle when there is one', () => {
    const r = migrateLegacyFields(
      legacy({
        pair_metadata: {
          paired_at: 1,
          server_passport_fingerprint: 'fp',
          server_handle_at_pair: 'alice',
        } as WebclientServerProfile['pair_metadata'],
      }),
      mintId,
    )!;
    expect(activeProfile(r)!.label).toBe('alice');
  });

  it('preserves non-URL credential residue as a pending repair record', () => {
    const pair_metadata = {
      paired_at: 1,
      server_passport_fingerprint: 'fp',
      server_handle_at_pair: 'alice',
      instance_id: 'browser-old',
    } as WebclientServerProfile['pair_metadata'];

    const r = migrateLegacyFields({ pair_metadata }, mintId)!;

    expect(r).not.toBeNull();
    expect(isPendingProfile(activeProfile(r)!)).toBe(true);
    expect(activeProfile(r)?.pair_metadata).toEqual(pair_metadata);
    expect(connectableProfiles(r)).toEqual([]);
  });

  it('returns null for a browser that was never paired', () => {
    // Not an empty profile with a null URL — that would render a nameless
    // switcher row that can never connect.
    expect(migrateLegacyFields({}, mintId)).toBeNull();
    expect(migrateLegacyFields({ server_url: null }, mintId)).toBeNull();
    expect(migrateLegacyFields({ server_url: '' }, mintId)).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════
// Repair scoping — the regression profiles would otherwise introduce
// ══════════════════════════════════════════════════════════════════
//
// Cold-start repair fires when the ACTIVE server's stored generation is
// partial or unreadable, and its historic remedy is a whole-store wipe plus
// an AES-GCM key wipe. Both are correct for one paired server and destructive
// for several: the key is ONE per origin, wrapping every profile's bearer.
// These pin the roster arithmetic the entry's scoped wipers read.

describe('repair scoping', () => {
  it('removing the broken ACTIVE profile leaves the others whole', () => {
    let r = roster(HOME, OFFICE);
    const home = r.profiles.find((p) => p.server_url === HOME)!;
    r = { ...r, activeId: home.id };
    const next = removeProfile(r, home.id);
    expect(next.profiles).toHaveLength(1);
    // The surviving server keeps its identity AND its wrapped bearer — the
    // whole point of not reaching for the whole-store wipe.
    expect(next.profiles[0]!.server_url).toBe(OFFICE);
    expect(activeProfile(next)?.server_url).toBe(OFFICE);
  });

  it('a one-profile roster empties, which is where a whole-store wipe is the same act', () => {
    // Every install predating profiles is this case, so the historic
    // behaviour has to survive it exactly.
    const r = roster(HOME);
    expect(r.profiles).toHaveLength(1);
    const next = removeProfile(r, r.profiles[0]!.id);
    expect(next).toEqual({ profiles: [], activeId: null });
  });
});

describe('beginPendingProfile — the add-a-server attempt', () => {
  it('opens a pending profile and makes it active', () => {
    const r = beginPendingProfile(roster(HOME), mintId);
    expect(r.profiles).toHaveLength(2);
    const active = activeProfile(r)!;
    expect(isPendingProfile(active)).toBe(true);
    // The boot must read this as unpaired so it lands on the pair form.
    expect(projectProfile(active).server_url).toBeNull();
  });

  it('reuses an attempt already open instead of littering the roster', () => {
    // Clicking "Add another server…" twice must not leave two ghosts behind.
    let r = beginPendingProfile(roster(HOME), mintId);
    const firstId = r.activeId;
    r = beginPendingProfile(r, mintId);
    expect(r.profiles).toHaveLength(2);
    expect(r.activeId).toBe(firstId);
  });

  it('switching away DROPS the abandoned attempt', () => {
    // The return path: an owner who changes their mind goes back to a working
    // server, and the half-made record goes with them rather than accumulating
    // invisibly (it is filtered from every list, so nothing would clean it up).
    const base = roster(HOME);
    const homeId = base.profiles[0]!.id;
    const r = beginPendingProfile(base, mintId);
    expect(r.profiles).toHaveLength(2);
    const back = switchTo(r, homeId);
    expect(back.profiles).toHaveLength(1);
    expect(back.profiles[0]!.server_url).toBe(HOME);
    expect(back.activeId).toBe(homeId);
  });

  it('completing the pairing ADOPTS the attempt rather than adding a row', () => {
    let r = beginPendingProfile(roster(HOME), mintId);
    r = ensureActiveProfileFor(r, OFFICE, mintId);
    expect(r.profiles).toHaveLength(2);
    expect(activeProfile(r)?.server_url).toBe(OFFICE);
    expect(r.profiles.some(isPendingProfile)).toBe(false);
  });

  it('switching between two real servers leaves both alone', () => {
    // The drop above must key on PENDING, not on "switching away from
    // anything" — that would delete a working server on every switch.
    const r = roster(HOME, OFFICE);
    const homeId = r.profiles.find((p) => p.server_url === HOME)!.id;
    const next = switchTo(r, homeId);
    expect(next.profiles).toHaveLength(2);
  });
});
