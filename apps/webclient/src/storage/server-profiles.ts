/** Server profiles — the roster behind the webclient's five per-server fields.
 *
 *  ── Why this layer exists ───────────────────────────────────────────────
 *  `server_url` / `webclient_token` / `server_public_key` / `pair_metadata` /
 *  `cert_pin_state` describe ONE paired server. Held as top-level singletons
 *  they left a browser with exactly two moves when its server went offline:
 *  wait, or clear site data and pair again. There was nowhere for a second
 *  server's values to live, so "point this browser at a different server" was
 *  not a missing button — it was a missing shape.
 *
 *  ── The shape ───────────────────────────────────────────────────────────
 *  Physically the store holds `server_profiles` (the roster) and
 *  `active_profile_id`. Logically the five names still resolve, now against
 *  whichever profile is active — so every existing reader
 *  (`localStore.get('server_url')`, and 70-odd siblings) keeps working
 *  unchanged, and switching servers is one write to `active_profile_id`
 *  rather than a rewrite of five keys that could half-apply.
 *
 *  ── What this module is NOT ─────────────────────────────────────────────
 *  It does not connect, unwrap, or validate anything. It is the pure
 *  roster algebra — read/modify/write over the two physical keys — so the
 *  switch semantics can be tested without IndexedDB, crypto, or a socket.
 *  The AES-GCM AAD binds each token to its own profile's
 *  `(token_id, server_url, server_public_key)`, so a token moved between
 *  profiles fails AEAD verify at unwrap; nothing here needs to enforce that.
 */

import type {
  WebclientServerProfile,
  WebclientLocalStorage,
  WebclientLocalKey,
} from '@recued/contracts';

/** The per-server fields a profile carries — the five logical names, minus
 *  the roster bookkeeping (`id` / `label` / `last_connected_at`). */
export const PROFILE_FIELD_KEYS: ReadonlyArray<WebclientLocalKey> = [
  'server_url',
  'webclient_token',
  'server_public_key',
  'pair_metadata',
  'cert_pin_state',
] as const;

/** An empty profile record for `url`. Everything else arrives at pair time. */
export const blankProfile = (
  id: string,
  server_url: string,
  label?: string,
): WebclientServerProfile => ({
  id,
  label: label ?? defaultProfileLabel(server_url),
  server_url,
  webclient_token: null,
  server_public_key: null,
  pair_metadata: null,
  cert_pin_state: null,
  last_connected_at: null,
});

/** Human label for a server with no handle yet: its host, or the raw string
 *  when it will not parse (never throw on a label). */
export const defaultProfileLabel = (server_url: string): string => {
  try {
    const parsed = new URL(server_url);
    return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  } catch {
    return server_url;
  }
};

/** Project a profile down to the five-field view the logical store serves.
 *  `null` (no active profile) reads as all-null — the same thing an unpaired
 *  browser has always reported, so callers need no new branch. */
export const projectProfile = (
  profile: WebclientServerProfile | null,
): WebclientLocalStorage => ({
  // A PENDING profile projects as unpaired, because that is what it is: a
  // record waiting for a URL. Returning its empty string instead would hand
  // every `get('server_url')` caller a value that is neither a URL nor null.
  server_url: profile?.server_url ? profile.server_url : null,
  webclient_token: profile?.webclient_token ?? null,
  server_public_key: profile?.server_public_key ?? null,
  pair_metadata: profile?.pair_metadata ?? null,
  cert_pin_state: profile?.cert_pin_state ?? null,
});

export interface ProfileRoster {
  readonly profiles: ReadonlyArray<WebclientServerProfile>;
  readonly activeId: string | null;
}

export const EMPTY_ROSTER: ProfileRoster = { profiles: [], activeId: null };

/** The active record, or null when the roster is empty or the pointer is
 *  dangling. A dangling pointer is treated as "no active profile" rather
 *  than repaired here — the caller that writes decides how to heal it, and
 *  a read must never mutate. */
export const activeProfile = (
  roster: ProfileRoster,
): WebclientServerProfile | null =>
  roster.profiles.find((p) => p.id === roster.activeId) ?? null;

/** A profile whose URL has not arrived yet.
 *
 *  Real callers write the five fields in whatever order suits them — the
 *  cert-pin watcher persists `cert_pin_state` on a browser that has never
 *  stored a URL, and pairing writes metadata around the URL rather than
 *  strictly after it. A roster that only accepted writes once a URL existed
 *  would DROP those silently, which is the worst possible failure for a
 *  store. So a write with no active profile opens a pending one and
 *  `ensureActiveProfileFor` adopts it when the URL lands. */
export const isPendingProfile = (p: WebclientServerProfile): boolean =>
  p.server_url.length === 0;

/** Profiles a switcher may offer. A pending record has no address to dial,
 *  so it is roster bookkeeping, not a destination. */
export const connectableProfiles = (
  roster: ProfileRoster,
): ReadonlyArray<WebclientServerProfile> =>
  roster.profiles.filter((p) => !isPendingProfile(p));

/** A trustworthy persisted recency value. Storage can outlive several app
 *  versions, so every consumer treats malformed, infinite, and pre-epoch
 *  values as unknown rather than letting them win ordering or fallback. */
export const validLastConnectedAt = (
  profile: Pick<WebclientServerProfile, 'last_connected_at'>,
): number | null => {
  const at = profile.last_connected_at;
  return typeof at === 'number' && Number.isFinite(at) && at >= 0 ? at : null;
};

/** Write one field of the ACTIVE profile, opening a pending profile first
 *  when there is none — see `isPendingProfile` for why silence is not an
 *  option here. */
export const setActiveField = (
  roster: ProfileRoster,
  key: WebclientLocalKey,
  value: WebclientLocalStorage[WebclientLocalKey],
  mintId?: () => string,
): ProfileRoster => {
  let base = roster;
  if (base.activeId === null || activeProfile(base) === null) {
    if (!mintId) return roster;
    const pending = blankProfile(mintId(), '', '');
    base = { profiles: [...base.profiles, pending], activeId: pending.id };
  }
  return {
    ...base,
    profiles: base.profiles.map((p) =>
      p.id === base.activeId ? { ...p, [key]: value } : p,
    ),
  };
};

/** Add a profile for `server_url` and make it active, or just activate the
 *  existing one when this browser already knows that URL.
 *
 *  Matching on URL — not on label — is what keeps re-pairing the SAME server
 *  from growing a second identical row every time credentials are replaced.
 *
 *  A PENDING active profile is adopted rather than left behind: the fields
 *  written before the URL arrived belong to this server, and abandoning them
 *  would strand a half-populated record in the roster forever. */
export const ensureActiveProfileFor = (
  roster: ProfileRoster,
  server_url: string,
  mintId: () => string,
): ProfileRoster => {
  const current = activeProfile(roster);
  // Prefer the record the caller just hydrated. A corrupt/legacy roster can
  // contain duplicate URLs; boot-time `ensureProfile(hydratedUrl)` must not
  // jump from that known generation to the first duplicate and then unwrap a
  // different token with the hydrated profile's AAD.
  const existing = current?.server_url === server_url
    ? current
    : roster.profiles.find((p) => p.server_url === server_url);
  if (existing) {
    // Adopting an existing URL retires any pending record — its fields were
    // written for THIS server, which already has a home.
    const pending = activeProfile(roster);
    const profiles =
      pending && isPendingProfile(pending) && pending.id !== existing.id
        ? roster.profiles.filter((p) => p.id !== pending.id)
        : roster.profiles;
    return { profiles, activeId: existing.id };
  }
  const pendingActive = activeProfile(roster);
  if (pendingActive && isPendingProfile(pendingActive)) {
    return {
      ...roster,
      profiles: roster.profiles.map((p) =>
        p.id === pendingActive.id
          ? {
            ...p,
            server_url,
            label: p.label.length > 0 ? p.label : defaultProfileLabel(server_url),
          }
          : p,
      ),
    };
  }
  const profile = blankProfile(mintId(), server_url);
  return { profiles: [...roster.profiles, profile], activeId: profile.id };
};

/** Point the runtime at another known profile. Unknown id → unchanged, so a
 *  stale switcher click cannot blank the active pointer and strand the app
 *  with no server at all.
 *
 *  Switching AWAY from a pending profile drops it. A pending record is an
 *  add-a-server attempt in progress; leaving it behind once the owner has
 *  gone back to a working server accumulates invisible ghosts in the roster
 *  (invisible because `connectableProfiles` filters them) that nothing would
 *  ever clean up. */
export const switchTo = (roster: ProfileRoster, id: string): ProfileRoster => {
  if (!roster.profiles.some((p) => p.id === id)) return roster;
  const leaving = activeProfile(roster);
  const profiles = leaving !== null && isPendingProfile(leaving) && leaving.id !== id
    ? roster.profiles.filter((p) => p.id !== leaving.id)
    : roster.profiles;
  return { profiles, activeId: id };
};

/** Open an add-a-server attempt: a pending profile, made active.
 *
 *  The boot then reads no `server_url` (a pending profile projects as
 *  unpaired), lands on the pair form, and pairing adopts this record via
 *  `ensureActiveProfileFor`. Reusing the existing pending profile rather than
 *  minting a second one means repeatedly clicking "Add another server" cannot
 *  litter the roster. */
export const beginPendingProfile = (
  roster: ProfileRoster,
  mintId: () => string,
): ProfileRoster => {
  const existing = roster.profiles.find(isPendingProfile);
  if (existing) return { ...roster, activeId: existing.id };
  const pending = blankProfile(mintId(), '', '');
  return { profiles: [...roster.profiles, pending], activeId: pending.id };
};

/** Drop a profile, including its stored bearer.
 *
 *  Removing the ACTIVE profile hands the pointer to the most recently
 *  connected survivor rather than to whatever happens to be first — after
 *  deleting a server you are most likely to want the one you were using
 *  before it. An empty roster leaves `activeId: null`, which reads as
 *  unpaired and lands the boot on the pair form. */
export const removeProfile = (
  roster: ProfileRoster,
  id: string,
): ProfileRoster => {
  const profiles = roster.profiles.filter((p) => p.id !== id);
  if (profiles.length === roster.profiles.length) return roster;
  if (roster.activeId !== id) return { ...roster, profiles };
  const fallback = [...profiles].sort(
    (a, b) => (validLastConnectedAt(b) ?? 0) - (validLastConnectedAt(a) ?? 0),
  )[0];
  return { profiles, activeId: fallback?.id ?? null };
};

/** Rename. Blank / whitespace-only input falls back to the URL-derived
 *  default so the switcher can never render an unclickable empty row. */
export const renameProfile = (
  roster: ProfileRoster,
  id: string,
  label: string,
): ProfileRoster => ({
  ...roster,
  profiles: roster.profiles.map((p) =>
    p.id === id
      ? { ...p, label: label.trim() || defaultProfileLabel(p.server_url) }
      : p,
  ),
});

/** Stamp a successful connect. Drives switcher ordering + the removal
 *  fallback above. */
export const noteConnected = (
  roster: ProfileRoster,
  id: string,
  at: number,
): ProfileRoster => {
  // A caller-supplied test clock or corrupt host must not poison ordering with
  // NaN / infinity / a pre-epoch value. Keep the last trustworthy stamp.
  if (!Number.isFinite(at) || at < 0) return roster;
  return {
    ...roster,
    profiles: roster.profiles.map((p) => {
      if (p.id !== id) return p;
      const previous = validLastConnectedAt(p);
      return {
        ...p,
        // Sibling tabs capture their clocks before waiting for the shared
        // roster lock. A later lock winner may therefore carry an older
        // timestamp; recency must never move backwards.
        last_connected_at: previous === null ? at : Math.max(previous, at),
      };
    }),
  };
};

/** Fold pre-profiles storage into a one-entry roster.
 *
 *  Runs against the five legacy top-level values. Five empty values were a
 *  true first run and migrate to no roster. Non-URL residue is different: it
 *  is evidence of an interrupted credential write and must survive in a
 *  non-connectable pending profile so cold-start repair can diagnose it
 *  instead of mislabelling the browser as new. */
export const migrateLegacyFields = (
  legacy: Partial<WebclientLocalStorage>,
  mintId: () => string,
): ProfileRoster | null => {
  const url = legacy.server_url;
  const usableUrl = typeof url === 'string' && url.length > 0 ? url : '';
  const hasCredentialResidue = [
    legacy.webclient_token,
    legacy.server_public_key,
    legacy.pair_metadata,
    legacy.cert_pin_state,
  ].some((value) => value !== undefined && value !== null);
  if (usableUrl.length === 0 && !hasCredentialResidue) return null;
  const profile: WebclientServerProfile = {
    ...blankProfile(
      mintId(),
      usableUrl,
      legacy.pair_metadata?.server_handle_at_pair,
    ),
    webclient_token: legacy.webclient_token ?? null,
    server_public_key: legacy.server_public_key ?? null,
    pair_metadata: legacy.pair_metadata ?? null,
    cert_pin_state: legacy.cert_pin_state ?? null,
  };
  return { profiles: [profile], activeId: profile.id };
};
