/** Zoned wall-clock ↔ instant, shared.
 *
 *  ⛔ MOVED HERE FROM `ports/reception/processors/intake-destination-mapping.ts`
 *  (D-269 step 3 follow-on). It had already drifted into being general: two
 *  consumers with nothing to do with reception intake imported it through that
 *  path, and a third — the quiet-hours preview — lives in the CLIENT, which
 *  cannot reach into `backend/` at all. **A general time primitive reached
 *  through a reception-processor path is the kind of import people
 *  re-implement instead of finding**, and re-implementing this one means
 *  re-deriving the two-pass DST correction below.
 *
 *  ⚠ There is no `Date` API for an IANA offset. Everything here derives it by
 *  asking `Intl` to render an instant IN the zone and reading the rendered wall
 *  clock back as if it were UTC. */

/** A wall-clock string the mapping accepts: a date (`2026-07-20`) or a local
 *  datetime (`2026-07-20T19:30[:SS]`). A zone suffix is deliberately NOT
 *  accepted — the config's `timezone` is the authority, and a value carrying
 *  its own zone would silently outrank it. */
const WALL_CLOCK_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/** The offset (ms) a zone was at for a given instant: `zone_local - utc`.
 *  Derived by asking `Intl` to render the instant IN the zone and reading the
 *  rendered wall clock back as if it were UTC. This is the only way to get an
 *  IANA offset in the platform — there is no `Date` API for it. */
export const zoneOffsetMsAt = (epochMs: number, timeZone: string): number => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(epochMs));
  const read = (type: string): number => {
    const raw = parts.find((p) => p.type === type)?.value;
    return raw === undefined ? Number.NaN : Number(raw);
  };
  // Some ICU builds render midnight as hour 24 under `hour12: false`.
  const hour = read('hour') === 24 ? 0 : read('hour');
  const asIfUtc = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    hour,
    read('minute'),
    read('second'),
  );
  return asIfUtc - epochMs;
};

/** Interpret a zone-less wall clock IN a given IANA zone → epoch ms.
 *  `null` for a malformed string or an unknown zone (`Intl` throws a
 *  `RangeError` on a bad `timeZone`, which must not escape as a 500).
 *
 *  Two passes, because the offset depends on the very instant we are solving
 *  for: the first guess uses the offset at the naive-UTC reading, the second
 *  re-measures at that guess. They differ only across a DST transition, where
 *  the second answer is the correct one. (A wall clock inside a spring-forward
 *  gap does not exist; the correction lands it just after the jump, which is
 *  the same thing every calendar UI does.) */
export const zonedWallClockToEpochMs = (
  wallClock: string,
  timeZone: string,
): number | null => {
  const m = WALL_CLOCK_RE.exec(wallClock.trim());
  if (m === null) return null;
  const [, y, mo, d, hh, mi, ss] = m;
  const naiveUtc = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(hh ?? '0'),
    Number(mi ?? '0'),
    Number(ss ?? '0'),
  );
  if (!Number.isFinite(naiveUtc)) return null;
  try {
    const firstOffset = zoneOffsetMsAt(naiveUtc, timeZone);
    if (!Number.isFinite(firstOffset)) return null;
    const guess = naiveUtc - firstOffset;
    const secondOffset = zoneOffsetMsAt(guess, timeZone);
    if (!Number.isFinite(secondOffset)) return null;
    return firstOffset === secondOffset ? guess : naiveUtc - secondOffset;
  } catch {
    // Unknown IANA zone. The config validator does not verify zone existence
    // (the closed list is the platform's, not ours), so fail here rather than
    // let a `RangeError` surface as a crashed materialize.
    return null;
  }
};
/** D-269 — the zone a cron schedule is read in.
 *
 *  ⛔⛔ ONE PLACE, BECAUSE THE DEFAULT IS THE WHOLE DECISION. Four call sites
 *  resolve a schedule's zone — the runtime loop's recompute after a fire,
 *  create/update, the pre-approval next-fire, and D-266's missed-run backfill —
 *  and if any of them defaults differently, that schedule fires at one hour and
 *  is counted as missed at another.
 *
 *  ⚠ RESOLVED AT EVALUATION, NOT BACKFILLED. A schedule written before D-269
 *  carries no zone; it takes the server's declared one every time it is read,
 *  so an owner who later corrects their timezone fixes their old schedules too.
 *  A migration that stamped a value at upgrade could not do that — it would
 *  freeze whatever the host happened to be that day. */
export const cronZoneFor = (
  schedule: { time_zone?: string },
  declaredServerZone: string,
): string => {
  const own = schedule.time_zone;
  return typeof own === 'string' && own.length > 0 ? own : declaredServerZone;
};
