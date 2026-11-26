import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { isAssetDate, isOccasionAlertMinutes, isOccasionTimeZone, nextAnnualDate, OCCASION_TIME, validateAssetRule, type Episode, type EpisodeInput, type Occasion, type OccasionInput,
  type ProactiveSuppression, type SituationPlace, type SituationRef } from '@recued/contracts';
import type { ProactiveProposalStore } from './proactive-proposal-store.js';

const validText = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
const validTime = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= 8.64e15;
const normalize = (name: string) => name.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en');
const EPISODE_LIST_ORDER = "json_extract(p.value,'$.when.from') DESC,p.updated_at DESC,p.id";
const list = <T>(db: Database.Database, table: string, limit: number, offset = 0): T[] => {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000 || !Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid history page');
  return (db.prepare(`SELECT value FROM ${table} ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`).all(limit, offset) as { value: string }[]).map(row => JSON.parse(row.value));
};
const validatePeople = (people: string[]) => {
  if (!Array.isArray(people) || people.length > 100 || people.some(id => !validText(id, 2000))) throw new Error('People must be contact identities');
};
export const episodeCandidateId = (sources: readonly SituationRef[]): string => `episode-${createHash('sha256')
  .update(JSON.stringify([...new Set(sources.map(ref => JSON.stringify([ref.collection, ref.id])))].sort())).digest('hex')}`;

export const createProactiveHistoryStore = (db: Database.Database, proposals: ProactiveProposalStore) => {
  db.exec(`CREATE TABLE IF NOT EXISTS proactive_episodes (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS proactive_occasions (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS proactive_places (key TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS proactive_place_aliases (alias TEXT PRIMARY KEY, place_key TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS proactive_dark_candidates (
      id TEXT PRIMARY KEY, class_id TEXT NOT NULL, at INTEGER NOT NULL, value TEXT NOT NULL,
      scored_at INTEGER, relevant INTEGER, evidence TEXT
    );
    CREATE TABLE IF NOT EXISTS proactive_episode_feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, episode_id TEXT NOT NULL, at INTEGER NOT NULL, outcome TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS proactive_history_receipts (source_key TEXT PRIMARY KEY, at INTEGER NOT NULL);`);
  if (!(db.prepare('PRAGMA table_info(proactive_episode_feedback)').all() as { name: string }[]).some(row => row.name === 'assembly_rule')) db.exec('ALTER TABLE proactive_episode_feedback ADD COLUMN assembly_rule TEXT');
  db.exec('CREATE TABLE IF NOT EXISTS proactive_episode_shown (episode_id TEXT NOT NULL,assembly_rule TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(episode_id,assembly_rule))');
  db.exec('CREATE INDEX IF NOT EXISTS proactive_dark_evidence ON proactive_dark_candidates(class_id,evidence) WHERE relevant=1');
  db.exec('CREATE TABLE IF NOT EXISTS proactive_dark_counts (class_id TEXT PRIMARY KEY, scored INTEGER NOT NULL, relevant INTEGER NOT NULL)');
  const get = <T>(table: string, id: string): T | null => {
    const row = db.prepare(`SELECT value FROM ${table} WHERE id=?`).get(id) as { value: string } | undefined; return row ? JSON.parse(row.value) : null;
  };
  const episode = (id: string): Episode | null => get('proactive_episodes', id);
  /** The episodes the owner hid from their lists (P44), as the JSON a query's `json_each` reads. */
  const hiddenEpisodes = (): string => JSON.stringify(proposals.suppressions().flatMap(row => row.kind === 'episode' && row.value && !row.of ? [row.value] : []));
  const occasion = (id: string): Occasion | null => get('proactive_occasions', id);
  const saveEpisode = (input: EpisodeInput, at: number): Episode => {
    if (!input || !validText(input.title, 500) || !input.when || !validTime(input.when.from) || !validTime(input.when.to) || input.when.from > input.when.to
      || !['declared', 'derived', 'inferred'].includes(input.basis) || !['owner_record', 'owner_correction', 'owner_annotation', 'proposal_citation', 'recurrence'].includes(input.storage_reason)
      || !Array.isArray(input.evidence) || !Array.isArray(input.subjects) || !Array.isArray(input.sensitive)
      || input.sensitive.some(value => !['health', 'pregnancy', 'money_under_stress', 'relationships'].includes(value))
      || JSON.stringify(input).length > 65536) throw new Error('Invalid episode, evidence or reason to retain it');
    validatePeople(input.people);
    if (input.when.to > at) throw new Error('An episode records what happened; its time cannot be in the future');
    if (input.where && (!validText(input.where.key, 2000) || !validText(input.where.name, 500))) throw new Error('Invalid episode place');
    if (input.evidence.length > 100 || input.subjects.length > 100 || [...input.evidence, ...input.subjects].some(ref => !validText(ref.collection, 200) || !validText(ref.id, 2000))) throw new Error('Invalid episode evidence');
    if (input.sphere !== undefined && !['personal', 'professional'].includes(input.sphere)) throw new Error('Invalid episode sphere');
    if (input.outcome !== undefined && !['done', 'skipped'].includes(input.outcome)) throw new Error('Invalid episode outcome');
    const old = input.id ? episode(input.id) : null;
    const id = input.id ?? `episode-${randomUUID()}`;
    const value: Episode = { ...structuredClone(input), id, created_at: old?.created_at ?? at, updated_at: at };
    db.prepare('INSERT INTO proactive_episodes(id,updated_at,value) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,value=excluded.value').run(id, at, JSON.stringify(value));
    return value;
  };
  /** `current` is the suppressions a caller already read, for one that checks many
   * items in a pass, as `allows` takes them; otherwise each call reads them. */
  const suppressed = (input: Pick<Episode, 'id' | 'when' | 'where' | 'people'> & { class_id?: string },
    current?: readonly ProactiveSuppression[]): boolean => (current ?? proposals.suppressions()).some(row =>
    row.kind === 'episode' && row.value === input.id || row.kind === 'person' && input.people.includes(row.value ?? '')
    || row.kind === 'place' && row.value === input.where?.key
    || row.kind === 'date_range' && row.from! <= input.when.to && row.to! >= input.when.from
    || row.kind === 'proposal_kind' && row.value === input.class_id);
  /** P17 — a dismissed episode is never shown again, including after re-assembly:
   * once its trace joins a plan, the same event returns under the plan's id, citing
   * these same sources, so each cited source is suppressed with it. An assembled
   * episode is not stored, so its caller passes the evidence it was shown with. */
  const suppressEpisode = (id: string, at: number, evidence: readonly SituationRef[] = episode(id)?.evidence ?? [], label = episode(id)?.title): void => {
    proposals.saveSuppression({ kind: 'episode', value: id, ...(label ? { label } : {}) }, at);
    for (const ref of evidence) proposals.saveSuppression({ kind: 'episode', value: episodeCandidateId([ref]), of: id }, at);
  };
  return {
    episode, occasion, saveEpisode, suppressed, suppressEpisode,
    /** P44 — the owner's lists of stored episodes (Episodes, a contact's page, an
     * occasion's history, a pursuit's) leave out one hidden there. It stays stored: assembly and
     * retention still read it, and the exclusion list names it. D-343 slice 5: they read in the
     * order things happened, the latest first, so a day closed days later sits on its own day
     * (Episodes groups them by day). `subject` keeps the episodes that cite an item. */
    listedEpisodes: (scope: { person?: string; occasion?: string; subject?: SituationRef }, limit = 50, offset = 0): Episode[] => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000 || !Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid history page');
      return (db.prepare(`SELECT p.value FROM proactive_episodes p WHERE p.id NOT IN (SELECT value FROM json_each(@hidden))
        ${scope.person !== undefined ? "AND EXISTS (SELECT 1 FROM json_each(p.value,'$.people') WHERE json_each.value=@person)" : ''}
        ${scope.occasion !== undefined ? "AND json_extract(p.value,'$.occasion_id')=@occasion" : ''}
        ${scope.subject !== undefined ? `AND EXISTS (SELECT 1 FROM json_each(p.value,'$.subjects') s
          WHERE json_extract(s.value,'$.collection')=@subject_collection AND json_extract(s.value,'$.id')=@subject_id)` : ''}
        ORDER BY ${EPISODE_LIST_ORDER} LIMIT @limit OFFSET @offset`)
        .all({ hidden: hiddenEpisodes(), limit, offset, ...(scope.person !== undefined ? { person: scope.person } : {}), ...(scope.occasion !== undefined ? { occasion: scope.occasion } : {}),
          ...(scope.subject !== undefined ? { subject_collection: scope.subject.collection, subject_id: scope.subject.id } : {}) }) as { value: string }[])
        .map(row => JSON.parse(row.value));
    },
    /** The episode's position in the owner's unscoped list, using the same ordering and exclusions. */
    listedEpisodeOffset: (id: string): number | null => {
      const row = db.prepare(`SELECT position FROM (
        SELECT p.id, ROW_NUMBER() OVER (ORDER BY ${EPISODE_LIST_ORDER}) - 1 AS position
        FROM proactive_episodes p WHERE p.id NOT IN (SELECT value FROM json_each(?))
      ) WHERE id=?`).get(hiddenEpisodes(), id) as { position: number } | undefined;
      return row?.position ?? null;
    },
    /** D-343 (2026-11-15) — the closing records (`owner_record.v1`) of a day: each one whose window
     * starts in [from, until), from whichever conversation recorded it, the earliest first, with when
     * it was last written. One hidden in the owner's lists is left out, as there. */
    ownerRecordsIn: (from: number, until: number): Array<Episode & { recorded_at: number }> =>
      (db.prepare(`SELECT p.value,p.updated_at FROM proactive_episodes p WHERE p.id NOT IN (SELECT value FROM json_each(@hidden))
        AND json_extract(p.value,'$.assembly_rule')='owner_record.v1'
        AND json_extract(p.value,'$.when.from')>=@from AND json_extract(p.value,'$.when.from')<@until
        ORDER BY json_extract(p.value,'$.when.from'),p.updated_at,p.id LIMIT 200`)
        .all({ hidden: hiddenEpisodes(), from, until }) as { value: string; updated_at: number }[])
        .map(row => ({ ...JSON.parse(row.value) as Episode, recorded_at: row.updated_at })),
    /** D-343 slice 5 — when the owner did each of these items (a pursuit): the start of every stored
     * episode that cites one and says it was done (a closing record's `outcome`, or none), the
     * latest first. A skipped record is not done, and one hidden in their lists counts for nothing. */
    doneFor: (collection: string, ids: readonly string[]): Array<{ id: string; from: number }> => ids.length === 0 ? []
      : db.prepare(`SELECT json_extract(s.value,'$.id') AS id,json_extract(p.value,'$.when.from') AS "from"
        FROM proactive_episodes p,json_each(p.value,'$.subjects') s
        WHERE json_extract(s.value,'$.collection')=@collection AND json_extract(s.value,'$.id') IN (SELECT value FROM json_each(@ids))
          AND IFNULL(json_extract(p.value,'$.outcome'),'done')='done' AND p.id NOT IN (SELECT value FROM json_each(@hidden))
        ORDER BY "from" DESC`).all({ collection, ids: JSON.stringify(ids), hidden: hiddenEpisodes() }) as Array<{ id: string; from: number }>,
    walkOccasions: (after = '', limit = 100): Occasion[] => (db.prepare('SELECT value FROM proactive_occasions WHERE id>? ORDER BY id LIMIT ?')
      .all(after, limit) as { value: string }[]).map(row => JSON.parse(row.value)),
    occasionDeleted: (id: string): boolean => Boolean(db.prepare('SELECT 1 FROM proactive_history_receipts WHERE source_key=?').get(`deleted-occasion:${id}`)),
    episodes: (limit = 100, offset = 0): Episode[] => list(db, 'proactive_episodes', limit, offset),
    forPerson: <K extends 'episode' | 'occasion'>(kind: K, person: string, limit = 50, offset = 0): Array<K extends 'episode' ? Episode : Occasion> =>
      (db.prepare(`SELECT p.value FROM ${kind === 'episode' ? 'proactive_episodes' : 'proactive_occasions'} p WHERE EXISTS (SELECT 1 FROM json_each(p.value,'$.people') WHERE json_each.value=?) ORDER BY p.updated_at DESC,p.id LIMIT ? OFFSET ?`)
        .all(person, limit, offset) as { value: string }[]).map(row => JSON.parse(row.value)),
    occasions: (limit = 100, offset = 0): Occasion[] => list(db, 'proactive_occasions', limit, offset),
    saveOccasion(input: OccasionInput, at: number): Occasion {
      if (!input || !validText(input.title, 500) || !nextAnnualDate(input.month_day, '2000-01-01') || typeof input.muted !== 'boolean'
        || !Array.isArray(input.rules) || input.rules.length > 100 || JSON.stringify(input).length > 65536) throw new Error('Invalid occasion');
      validatePeople(input.people);
      if (input.source_next_on !== undefined && input.source_next_on !== null && !isAssetDate(input.source_next_on)) throw new Error('Invalid occasion date');
      if (input.where && (!validText(input.where.key, 2000) || !validText(input.where.name, 500))) throw new Error('Invalid occasion place');
      if (input.sphere !== undefined && !['personal', 'professional'].includes(input.sphere)) throw new Error('Invalid occasion sphere');
      // D-407 slice 3 — Private or Shown by name, nothing else (`occasionIsPrivate` reads only these too).
      if (input.private !== undefined && typeof input.private !== 'boolean') throw new Error('Invalid occasion privacy');
      // D-407 slice 2 — whenever the last one says: its next one is a date, and it is the owner's, not a contact's or a calendar's.
      if (input.after_each !== undefined && (input.after_each !== true || typeof input.source_next_on !== 'string'
        || !isAssetDate(input.source_next_on) || input.source !== undefined)) throw new Error('Invalid occasion repeat');
      // D-407 slice 2 (Q2) — a time of day with the zone it is on, or neither.
      if ((input.time !== undefined || input.time_zone !== undefined)
        && (typeof input.time !== 'string' || !OCCASION_TIME.test(input.time) || !isOccasionTimeZone(input.time_zone))) throw new Error('Invalid occasion time');
      // D-407 — an alert is minutes before its time of day, so it needs one.
      if (input.alert_minutes !== undefined && (!isOccasionAlertMinutes(input.alert_minutes) || input.time === undefined)) throw new Error('Invalid occasion alert');
      // D-407 slice 4 — its own event: an owner's occasion only; a source dates the others.
      if (input.in_calendar !== undefined && (typeof input.in_calendar !== 'boolean' || (input.in_calendar && input.source !== undefined))) {
        throw new Error('Invalid occasion calendar');
      }
      for (const rule of input.rules) {
        if (rule.when.kind !== 'expiry' || rule.when.field !== 'next_on') throw new Error('An occasion rule reads its next_on date');
        if (rule.reaction.occurrence === 'action' && rule.expiry_policy !== 'strict_expire') throw new Error('An occasion habit expires after its actual due day');
        validateAssetRule(rule, { dates: { next_on: '2000-01-01' }, readings: {}, observations: {} });
      }
      if (new Set(input.rules.map(rule => rule.id)).size !== input.rules.length) throw new Error('Occasion rules need distinct identities');
      const old = input.id ? occasion(input.id) : null; const id = input.id ?? `occasion-${randomUUID()}`;
      // A rule that carried the occasion's own title, as its default rule does, follows a
      // rename; one the owner titled keeps its own.
      const renamed = old && old.title !== input.title ? input.rules.map(rule => rule.title === old.title ? { ...rule, title: input.title } : rule) : input.rules;
      const rules = !old && !input.rules.length ? [{ id: 'date', title: input.title, enabled: true, muted: false, pinned: false,
        consequence: 'routine' as const, expiry_policy: 'strict_expire' as const, when: { kind: 'expiry' as const, field: 'next_on' },
        reaction: { notify: true, occurrence: 'notice' as const, emit: false }, schedule: { before: [{ amount: 1, unit: 'weeks' as const }], on_day: true } }] : renamed;
      const value: Occasion = { ...structuredClone(input), rules, month_day: input.month_day.replace(/^--/u, ''), id, created_at: old?.created_at ?? at, updated_at: at };
      db.prepare('INSERT INTO proactive_occasions(id,updated_at,value) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,value=excluded.value').run(id, at, JSON.stringify(value)); return value;
    },
    deleteOccasion(id: string): void { db.transaction(() => {
      // Only a contact or calendar declares an occasion again, so only theirs keeps a receipt.
      if (occasion(id)?.source) db.prepare('INSERT OR IGNORE INTO proactive_history_receipts(source_key,at) VALUES(?,?)').run(`deleted-occasion:${id}`, 0);
      db.prepare('DELETE FROM proactive_occasions WHERE id=?').run(id);
    })(); },
    deleteEpisode(id: string, at: number, suppress = true, evidence?: readonly SituationRef[], label?: string): void {
      if (suppress) suppressEpisode(id, at, evidence ?? episode(id)?.evidence ?? [], label ?? episode(id)?.title);
      db.prepare('DELETE FROM proactive_episodes WHERE id=?').run(id);
    },
    recordOwnerCorrection(id: string, at: number, assembly_rule?: string): void { db.prepare('INSERT INTO proactive_episode_feedback(episode_id,at,outcome,assembly_rule) VALUES(?,?,?,?)').run(id, at, 'corrected', assembly_rule ?? null); },
    recordShown(episode: EpisodeInput, at: number): void { if (episode.id && episode.assembly_rule) db.prepare('INSERT OR IGNORE INTO proactive_episode_shown(episode_id,assembly_rule,at) VALUES(?,?,?)').run(episode.id, episode.assembly_rule, at); },
    /** Retention: corrections and the views they count against, together, so a
     * rule's correction rate keeps both sides of one span. */
    pruneFeedback(before: number): { feedback: number; shown: number } {
      if (!Number.isSafeInteger(before)) throw new Error('Invalid feedback retention');
      return db.transaction(() => ({
        feedback: db.prepare('DELETE FROM proactive_episode_feedback WHERE at<?').run(before).changes,
        shown: db.prepare('DELETE FROM proactive_episode_shown WHERE at<?').run(before).changes,
      }))();
    },
    place(name: string): SituationPlace {
      const alias = normalize(name);
      const row = db.prepare('SELECT key,name FROM proactive_places JOIN proactive_place_aliases ON key=place_key WHERE alias=?').get(alias) as SituationPlace | undefined;
      return row ?? { key: `label:${alias}`, name: name.trim() };
    },
    savePlace(input: { key?: string; name: string; aliases: string[] }): SituationPlace {
      if (!validText(input.name, 500) || !Array.isArray(input.aliases) || input.aliases.length > 100 || input.aliases.some(alias => !validText(alias, 2000))) throw new Error('Invalid place names');
      const key = input.key ?? `place-${randomUUID()}`;
      const existing = db.prepare('SELECT name FROM proactive_places WHERE key=?').get(key);
      if (input.key && !existing) throw new Error('Place not found');
      return db.transaction(() => {
        db.prepare('INSERT INTO proactive_places(key,name) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET name=excluded.name').run(key, input.name);
        for (const name of [input.name, ...input.aliases]) {
          const alias = normalize(name); const old = db.prepare('SELECT place_key FROM proactive_place_aliases WHERE alias=?').get(alias) as { place_key: string } | undefined;
          if (old && old.place_key !== key) throw new Error('This name already identifies a different place');
          db.prepare('INSERT OR IGNORE INTO proactive_place_aliases(alias,place_key) VALUES(?,?)').run(alias, key);
        }
        return { key, name: input.name };
      })();
    },
    darkCandidate(input: { id: string; class_id: string; episode: EpisodeInput; window: { from: number; to: number } }, at: number): void {
      if (!validText(input.id, 2000) || !validText(input.class_id, 100) || !validTime(input.window.from) || !validTime(input.window.to) || input.window.to < input.window.from) throw new Error('Invalid dark candidate');
      // The candidate is evidence, not a retained episode and never an offer.
      db.prepare('INSERT OR IGNORE INTO proactive_dark_candidates(id,class_id,at,value) VALUES(?,?,?,?)').run(input.id, input.class_id, at, JSON.stringify(input));
    },
    scoreDarkCandidate(id: string, relevant: boolean, evidence: SituationRef | null, at: number): void {
      if (typeof relevant !== 'boolean' || (relevant && !evidence)) throw new Error('A relevant score needs actual trace evidence');
      if (relevant && db.prepare('SELECT 1 FROM proactive_dark_candidates WHERE class_id=(SELECT class_id FROM proactive_dark_candidates WHERE id=?) AND evidence=? AND relevant=1').get(id, JSON.stringify(evidence))) return;
      db.prepare('UPDATE proactive_dark_candidates SET scored_at=?,relevant=?,evidence=? WHERE id=? AND scored_at IS NULL')
        .run(at, relevant ? 1 : 0, evidence ? JSON.stringify(evidence) : null, id);
    },
    darkRates: (): Array<{ class_id: string; scored: number; relevant: number; rate: number }> =>
      (db.prepare(`SELECT class_id,sum(scored) AS scored,sum(relevant) AS relevant FROM (
        SELECT class_id,count(*) AS scored,sum(relevant) AS relevant FROM proactive_dark_candidates WHERE scored_at IS NOT NULL GROUP BY class_id
        UNION ALL SELECT class_id,scored,relevant FROM proactive_dark_counts) GROUP BY class_id`).all() as { class_id: string; scored: number; relevant: number }[])
        .map(row => ({ ...row, rate: row.relevant / row.scored })),
    /** Retention: a candidate a year past its window counts only towards its class's
     * rate, so a scored one folds into the class's counts. An unscored one goes: the
     * run leaves a candidate unscored only while its episode is withheld. */
    foldDark(before: number): { dark_folded: number; dark_dropped: number } {
      if (!Number.isSafeInteger(before)) throw new Error('Invalid dark-run retention');
      const old = "json_extract(value,'$.window.to')<?";
      return db.transaction(() => {
        const counts = db.prepare(`SELECT class_id,count(*) AS scored,sum(relevant) AS relevant FROM proactive_dark_candidates WHERE scored_at IS NOT NULL AND ${old} GROUP BY class_id`)
          .all(before) as { class_id: string; scored: number; relevant: number }[];
        const add = db.prepare('INSERT INTO proactive_dark_counts(class_id,scored,relevant) VALUES(?,?,?) ON CONFLICT(class_id) DO UPDATE SET scored=scored+excluded.scored,relevant=relevant+excluded.relevant');
        for (const row of counts) add.run(row.class_id, row.scored, row.relevant);
        return { dark_folded: db.prepare(`DELETE FROM proactive_dark_candidates WHERE scored_at IS NOT NULL AND ${old}`).run(before).changes,
          dark_dropped: db.prepare(`DELETE FROM proactive_dark_candidates WHERE scored_at IS NULL AND ${old}`).run(before).changes };
      })();
    },
    /** §4.9 — forgetting the dark run forgets its folded counts with it. */
    forgetDark(): void { db.exec('DELETE FROM proactive_dark_candidates; DELETE FROM proactive_dark_counts;'); },
    darkPending: (after = '', limit = 10000): Array<{ id: string; class_id: string; episode: EpisodeInput; window: { from: number; to: number } }> =>
      (db.prepare('SELECT value FROM proactive_dark_candidates WHERE scored_at IS NULL AND id>? ORDER BY id LIMIT ?').all(after, limit) as { value: string }[]).map(row => JSON.parse(row.value)),
  };
};
export type ProactiveHistoryStore = ReturnType<typeof createProactiveHistoryStore>;
