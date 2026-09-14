/** D-269 step 1 — the server's own timezone, declared or followed.
 *
 *  ⛔⛔ WHY THIS EXISTS AT ALL. Every surface that needed a zone read it off
 *  whichever CLIENT happened to be there (`Intl…resolvedOptions().timeZone`),
 *  and the server's own fallback read its HOST OS. Both are guesses about where
 *  a person is, made by something that cannot see them, and they fail in
 *  opposite deployments:
 *
 *    laptop install   host zone IS the owner's zone      → reading the host is RIGHT
 *    VPS / NAS        host zone is a datacenter's        → reading the host is WRONG
 *
 *  🔑 SO THE ORIGINAL CODE WAS NOT A BUG — it was a correct default for one
 *  deployment, applied unconditionally. `chat-turn-executor.ts` says so itself:
 *  *"defaults to the server's local zone (home-host-correct: server-local ≈
 *  user-local)"*. The defect is that a deployment-dependent assumption was
 *  invisible and unchangeable, not that the host clock was consulted.
 *
 *  ⇒ **The fix is to NAME THE DEPLOYMENT, not to infer the zone.** What decides
 *  is where the MACHINE lives relative to its owner, and no clock reports that.
 *
 *  ── The precedence this establishes ──────────────────────────────
 *    live client zone  →  this setting  →  host OS zone (last resort)
 *
 *  The first answers *"what time is it where I am"* — a connected client's zone
 *  is live evidence of the owner's whereabouts, so it still wins per call. This
 *  setting answers *"what hours does this server treat as mine"*, which is the
 *  question a sweep asks with nobody connected. Two questions, two answers; the
 *  travel case only reads as a conflict when one value is asked to serve both.
 *
 *  ⛔ ZONES, NOT OFFSETS. `America/Los_Angeles` carries the RULES; PST and PDT
 *  are OUTPUTS of those rules at an instant, so the owner never sets PDT and
 *  never adjusts anything twice a year. ⚠ The obvious validator — "accept what
 *  `Intl` accepts" — IS NOT SUFFICIENT and the probe under
 *  `canonicalizeIanaZone` says why: `Intl` takes `'EST'` and silently resolves
 *  it to `America/Panama`, which never observes DST.
 *
 *  ⚠ AND THE ZONE IS NOT A LOCATION. An IANA id names a REPRESENTATIVE city, so
 *  `America/Los_Angeles` is the wrong city for most people in the zone by
 *  construction. That is why the chat packet renders the OFFSET and never this
 *  string (see `chat-prompt-optimization-log.md`) — a model parrots a city it is
 *  shown. A human reading a picker does not, so the picker may show it: the
 *  suppression belongs to the READER, not to the value.
 *
 *  Spec: internal design notes D-269 REV 3 / REV 5 / REV 9. */

/** Where this server lives relative to its owner. The one thing no clock can
 *  report, and therefore the one thing that must be declared. */
export type ServerTimeZoneMode =
  /** The machine stays put; the owner may not. A NAS, a home server, a VPS.
   *  `zone` is authoritative and does not move when the owner travels — which
   *  is the whole point: quiet hours stays on the owner's home clock. */
  | 'fixed'
  /** The machine travels WITH the owner — a laptop or the owner's desktop. The
   *  host OS zone is read afresh every time, so flying to London moves the
   *  server's idea of "night" to London with it.
   *  ⚠ This is the pre-D-269 behaviour, promoted from an accident to a choice. */
  | 'follows_host';

/** The stored setting. One row per server (Recued is solo-owner by design, so
 *  per-server IS per-owner and there is no second row to disagree with). */
export interface ServerTimeZoneSetting {
  mode: ServerTimeZoneMode;
  /** IANA zone id. Authoritative under `fixed`.
   *  ⚠ PRESERVED, NOT CLEARED, under `follows_host` — flipping to follows and
   *  back must not silently discard what the owner typed. */
  zone: string | null;
  updated_at: number;
}

/** ⛔⛔ `Intl` ACCEPTANCE IS NOT ENOUGH, AND ASSUMING IT WAS IS A LIVE TRAP.
 *  Probed rather than assumed (node 22):
 *
 *    'PST'        ACCEPTED → America/Los_Angeles   Jan -08:00 / Jun -07:00  ✓ DST-correct
 *    'EST'        ACCEPTED → America/PANAMA        Jan -05:00 / Jun -05:00  ⛔ NEVER shifts
 *    '-08:00'     ACCEPTED → -08:00                                        ⛔ NEVER shifts
 *    'Etc/GMT+8'  ACCEPTED → Etc/GMT+8                                     ⛔ NEVER shifts
 *    'UTC-08:00'  RangeError
 *
 *  🔑 So the abbreviations are not uniformly bad — `PST` is an alias for Los
 *  Angeles and behaves perfectly, while **`EST` silently means PANAMA**, which
 *  does not observe DST. A New Yorker who types the abbreviation they say out
 *  loud every day gets a clock that is an hour wrong for eight months of the
 *  year: exactly the failure this design exists to prevent, arriving through the
 *  validator that was supposed to prevent it.
 *
 *  ⇒ TWO MECHANISMS, because the two problems are different:
 *    1. **CANONICALISE** — store what the zone resolves to, never what was
 *       typed. `PST` becomes `America/Los_Angeles`; `EST` becomes
 *       `America/Panama`, and the picker showing that back is how a New Yorker
 *       SEES they did not get New York. Validation cannot read intent; making
 *       the resolution visible can.
 *    2. **REFUSE the rule-less forms** — a fixed offset can never track DST, so
 *       it is wrong twice a year by construction whatever the owner meant. That
 *       is not an intent question, so it is refused rather than shown. */
const OFFSET_SHAPED = /^[+-]\d{2}:?\d{2}$/;

/** Resolve an owner-typed zone to its canonical IANA id, or `null` when it
 *  cannot serve as a wall clock. ⚠ Returns the CANONICAL form — callers must
 *  store this, not the input, or the two mechanisms above collapse into one. */
export const canonicalizeIanaZone = (zone: unknown): string | null => {
  if (typeof zone !== 'string' || zone.trim().length === 0) return null;
  const input = zone.trim();
  let canonical: string;
  try {
    canonical = new Intl.DateTimeFormat('en-US', { timeZone: input })
      .resolvedOptions().timeZone;
  } catch {
    return null;
  }
  // ⛔ Rule-less: a fixed offset, however spelled. `Etc/GMT+8` is the tz
  // database's own fixed-offset family (and its sign is inverted from the
  // offset it names, which is a second reason not to let one through).
  if (OFFSET_SHAPED.test(canonical)) return null;
  if (canonical.startsWith('Etc/GMT')) return null;

  // ⚠ REWRITE ONLY WHAT HIDES SOMETHING. Probed: `Asia/Kolkata` canonicalises
  // to the DEPRECATED `Asia/Calcutta`, so rewriting everything would hand an
  // owner back a name they did not choose and did not recognise — noise, for no
  // safety. A `Region/City` input hides nothing (`Asia/Kolkata` IS Kolkata), so
  // it is kept verbatim.
  //
  // ⛔ An ABBREVIATION is the opposite: it is a name for something else, and
  // `EST` meaning `America/Panama` is precisely the thing that must stop being
  // invisible. Those are rewritten, so the owner is shown what they actually
  // set. ⇒ The rule is "make hidden meaning visible", NOT "normalise".
  return input.includes('/') ? input : canonical;
};

/** Boolean form of `canonicalizeIanaZone`, for guards and gates. */
export const isValidIanaZone = (zone: unknown): zone is string =>
  canonicalizeIanaZone(zone) !== null;

/** The setting a server starts with, before the owner has said anything.
 *
 *  ⛔ `fixed` IS THE SAFE DEFAULT, and not because it is more common. The two
 *  wrong answers are not symmetric: a wrong `fixed` shows up as a visibly wrong
 *  clock the two-clock preview puts in front of the owner, while a wrong
 *  `follows_host` on a VPS is SILENT and drifts with the datacenter. Default to
 *  the failure that announces itself. */
export const DEFAULT_SERVER_TIME_ZONE_MODE: ServerTimeZoneMode = 'fixed';

/** Resolve the zone this server should use when no live client supplies one.
 *
 *  ⛔ NEVER THROWS AND ALWAYS RETURNS A ZONE. The chat packet's `current_date`
 *  anchor depends on this, and a turn that renders no clock is worse than a turn
 *  that renders an imperfect one — observed live, a model with no date either
 *  refuses outright or burns tool-loop rounds guessing. So an unset or invalid
 *  setting degrades to the host zone rather than failing the caller.
 *
 *  ⚠ `hostZone` is the CALLER's reading of its own environment, injected rather
 *  than read here, so this stays pure and testable — and so a browser bundling
 *  these contracts never accidentally resolves a SERVER zone from ITS host. */
export const resolveServerTimeZone = (
  setting: ServerTimeZoneSetting | null | undefined,
  hostZone: string,
): string => {
  if (setting && setting.mode === 'fixed' && isValidIanaZone(setting.zone)) {
    return setting.zone;
  }
  // `follows_host`, unset, or a `fixed` row whose zone no longer validates (a
  // tz-database rename can do that to a row written years ago).
  return isValidIanaZone(hostZone) ? hostZone : 'UTC';
};

/** Whether the owner has said enough for a WALL-CLOCK feature to run.
 *
 *  🔑 The gate is RESOLVABLE, not DECLARED. `follows_host` satisfies it with
 *  nothing typed — a laptop owner never picks a zone and quiet hours still
 *  works — while `fixed` needs a zone that validates. ⚠ Do not re-express this
 *  as `zone !== null`; that reintroduces the blank-field requirement REV 9
 *  removed for exactly the deployment that needs it least. */
export const isServerTimeZoneConfigured = (
  setting: ServerTimeZoneSetting | null | undefined,
): boolean => {
  if (!setting) return false;
  return setting.mode === 'follows_host' || isValidIanaZone(setting.zone);
};

/** `server.timezone.get` — the stored setting plus what it resolves to RIGHT
 *  NOW, so a surface can render the two-clock preview without re-deriving the
 *  precedence (and without a browser mistaking its own zone for the server's). */
export interface ServerTimeZoneGetResponse {
  setting: ServerTimeZoneSetting;
  /** What `resolveServerTimeZone` returns at this instant. Under
   *  `follows_host` this is the host reading and the only way a client can
   *  learn it. */
  resolved_zone: string;
  /** The server's raw host zone, always — so the picker can offer it as the
   *  seed and the preview can explain a `fixed` value that disagrees with it. */
  host_zone: string;
}

/** `server.timezone.set`. `zone` is required when switching to `fixed` without
 *  one already stored; omitted under `follows_host` it leaves the stored value
 *  untouched (see `ServerTimeZoneSetting.zone`). */
export interface ServerTimeZoneSetRequest {
  mode: ServerTimeZoneMode;
  zone?: string | null;
}

/** Same shape as the get, so a caller re-renders from one response. */
export type ServerTimeZoneSetResponse = ServerTimeZoneGetResponse;
