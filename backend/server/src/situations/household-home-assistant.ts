import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AssetWriterConnection, AssetWriterSource, ConnectionRow, HouseholdHomeAssistantList, HouseholdHomeAssistantSelection } from '@recued/contracts';
import { connectionIdentity, connectionRevision } from '../connection-revision.js';
import type { WorkEntityStore } from '../storage/work-entity-store.js';
import { createAssetOccurrenceStore } from '../storage/asset-occurrence-store.js';
import { createHouseholdDeliveryStore } from '../storage/household-delivery-store.js';
import { makeBoundedOriginHttpFetcher, type BoundedHttpFetcher } from '../bounded-origin-http-fetcher.js';
import { releasedAtStop, settleWithin, STOP_GRACE_MS } from '../lifecycle/settle-within.js';

type Selection = HouseholdHomeAssistantSelection;
type Projection = { scope: string; occurrence_id: string; binding: Selection; marker: string; uid: string | null;
  started: boolean; withdrawn?: boolean; content?: string };
type TodoItem = { uid: string; summary: string; status: 'needs_action' | 'completed'; description?: string };
/** A Home Assistant to-do list's entity id, as `configure` accepts and `lists` offers. */
const TODO_ENTITY_ID = /^todo\.[a-z0-9_]{1,200}$/u;
/** These sources reveal device health, never motion, presence or occupancy. */
const writerSource = (raw: unknown): AssetWriterSource | undefined => {
  if (!raw || typeof raw !== 'object') return;
  const value = raw as { entity_id?: unknown; state?: unknown; attributes?: Record<string, unknown> };
  if (typeof value.entity_id !== 'string' || !/^[a-z_]+\.[a-z0-9_]{1,200}$/u.test(value.entity_id)) return;
  const attributes = value.attributes ?? {};
  const battery = attributes.device_class === 'battery' && attributes.unit_of_measurement === '%';
  const problem = attributes.device_class === 'problem';
  if (!battery && !problem && !/^(light|switch|fan|climate|cover)\./u.test(value.entity_id)) return;
  return { id: value.entity_id, name: typeof attributes.friendly_name === 'string' ? attributes.friendly_name.slice(0, 200) : value.entity_id,
    sample: `${typeof value.state === 'string' ? value.state.slice(0, 100) : 'Unknown'}${battery ? '%' : ''}`,
    fields: ['observations.unavailable', 'observations.flickering', ...(battery ? ['readings.battery'] : []), ...(problem ? ['observations.problem'] : [])] };
};
/** What a list must do for Recued to keep tasks there without duplicates: add (1),
 *  remove (2) and keep a description (64), which holds each task's marker. */
const REQUIRED_FEATURES: ReadonlyArray<[flag: number, missing: string]> = [
  [1, 'can’t add items'], [2, 'can’t remove items'], [64, 'can’t keep the note Recued adds to each item']];
export const homeAssistantBaseUrl = (row: ConnectionRow): string | null => {
  if (row.kind !== 'api') return null;
  try { const raw = JSON.parse(row.config_json).base_url; if (typeof raw !== 'string') return null;
    const url = new URL(raw); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return url.href.replace(/\/+$/u, '');
  } catch { return null; }
};
const scopeOf = (value: Selection) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface HouseholdHomeAssistantDeps {
  db: Database.Database; work: WorkEntityStore;
  /** Only connections bound to the installed Home Assistant catalog. */
  connections(): readonly ConnectionRow[];
  /** The same stable credential lineage used by execution's account guard. */
  authSourceId?(name: string): string | undefined;
  credential(row: ConnectionRow): Promise<string | null>;
  isVaultUnlocked?(): boolean; now?(): number; fetch?: BoundedHttpFetcher;
}
/** A projection ledger holds provider identities and uncertain writes only.
 * Lifecycle and deadlines always come from the original commitment. */
export const createHouseholdHomeAssistant = (deps: HouseholdHomeAssistantDeps) => {
  const settings = createHouseholdDeliveryStore(deps.db); const occurrences = createAssetOccurrenceStore(deps.db);
  const now = deps.now ?? Date.now; const fetcher = deps.fetch ?? makeBoundedOriginHttpFetcher({ timeoutMs: 5000, maxResponseBytes: 2_000_000, redirectPolicy: 'error' });
  // Every entity's state, read to find the to-do lists, outgrows one list's items on a large home.
  const listFetcher = deps.fetch ?? makeBoundedOriginHttpFetcher({ timeoutMs: 10_000, maxResponseBytes: 16_000_000, redirectPolicy: 'error' });
  /** ⛔ A STOP (`stop`) STARTS NO REQUEST AND ENDS THE READS IN FLIGHT — never a
   *  write. A pass makes up to 16 writes behind its reads, each with 5 s, and a
   *  drain step has 5 s while the process exits right after it anyway. Reads
   *  change nothing, so cutting one loses nothing: the next pass reads again.
   *  A write is left to finish, because an add cut short is the case this
   *  projection cannot repeat: it is marked started before it is sent, and one
   *  that never reached Home Assistant is then "uncertain" for good, by design
   *  (no second copy). Left alone, a write to a Home Assistant on the home
   *  network normally ends well inside the grace. What a stop leaves unwritten
   *  was never started, so the first pass after the restart (`fireImmediate`)
   *  writes it. */
  const stops = new AbortController();
  const reading: BoundedHttpFetcher = (url, init) => fetcher(url, { ...init, signal: stops.signal });
  const listReading: BoundedHttpFetcher = (url, init) => listFetcher(url, { ...init, signal: stops.signal });
  const stoppingError = (): Error => new Error('Recued is stopping; Home Assistant is updated after it starts again');
  deps.db.exec(`CREATE TABLE IF NOT EXISTS household_ha_projections(scope TEXT NOT NULL,occurrence_id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(scope,occurrence_id));
    CREATE TABLE IF NOT EXISTS household_ha_status(id INTEGER PRIMARY KEY CHECK(id=1),issue TEXT);`);
  const save = (row: Projection) => deps.db.prepare('INSERT INTO household_ha_projections(scope,occurrence_id,value) VALUES(?,?,?) ON CONFLICT(scope,occurrence_id) DO UPDATE SET value=excluded.value')
    .run(row.scope, row.occurrence_id, JSON.stringify(row));
  const all = (): Projection[] => (deps.db.prepare('SELECT value FROM household_ha_projections ORDER BY scope,occurrence_id').all() as { value: string }[]).map(row => JSON.parse(row.value));
  const issue = (text: string | null) => { deps.db.prepare('INSERT INTO household_ha_status(id,issue) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET issue=excluded.issue').run(text); };
  /** An issue is the owner's to read; a stop is not one, and the store may be closing. */
  const note = (text: string | null): void => { if (!stops.signal.aborted) issue(text); };
  const current = (binding: Selection): ConnectionRow | undefined => deps.connections().find(row => row.name === binding.connection_name
    && row.enrolled_at === binding.connection_enrolled_at && homeAssistantBaseUrl(row) === binding.base_url);
  const request = async (binding: Selection, path: string, body?: Record<string, unknown>, guard?: () => boolean, beforeSend?: () => void, via = fetcher) => {
    if (stops.signal.aborted) throw stoppingError();
    if (deps.isVaultUnlocked?.() === false) throw new Error('Unlock the vault to reach Home Assistant');
    const row = current(binding); if (!row) throw new Error('The selected Home Assistant connection is unavailable');
    const token = await deps.credential(row);
    // Checked again after the credential, before `beforeSend` marks a write started.
    if (stops.signal.aborted) throw stoppingError();
    if (!token || !current(binding) || deps.isVaultUnlocked?.() === false || guard?.() === false) throw new Error('The Home Assistant projection changed before delivery');
    beforeSend?.();
    const response = await via(`${binding.base_url}${path}`, { method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!current(binding) || deps.isVaultUnlocked?.() === false) throw new Error('Home Assistant connection changed during the request');
    if (!response.ok) throw new Error(`Home Assistant returned ${response.status}`);
    return response.json();
  };
  const features = async (binding: Selection): Promise<number> => {
    const state = await request(binding, `/api/states/${encodeURIComponent(binding.entity_id)}`, undefined, undefined, undefined, reading) as { entity_id?: string; state?: string; attributes?: { supported_features?: unknown } };
    const flags = state?.attributes?.supported_features;
    if (state?.entity_id !== binding.entity_id || ['unavailable', 'unknown'].includes(state.state ?? '') || !Number.isSafeInteger(flags) || Number(flags) < 0) throw new Error('The selected to-do list is unavailable');
    return Number(flags);
  };
  const items = async (binding: Selection): Promise<TodoItem[]> => {
    const response = await request(binding, '/api/services/todo/get_items?return_response', { entity_id: binding.entity_id, status: ['needs_action', 'completed'] },
      undefined, undefined, reading) as { service_response?: Record<string, { items?: unknown }> };
    const values = response?.service_response?.[binding.entity_id]?.items;
    if (!Array.isArray(values) || values.length > 5000 || values.some(row => !row || typeof row.uid !== 'string' || !row.uid || row.uid.length > 2000
      || typeof row.summary !== 'string' || !['needs_action', 'completed'].includes(row.status))) throw new Error('Home Assistant returned an incomplete to-do list');
    return values;
  };
  const context = (id: string) => {
    const row = occurrences.get(id); const asset = row && row.subject_kind !== 'occasion' ? deps.work.readAssetEffective(row.asset_id) : null;
    const rule = asset?.rules.find(rule => rule.id === row?.rule_id); const commitment = row?.commitment_id ? deps.work.readCommitment(row.commitment_id) : null;
    return row && !row.question && asset && asset.deleted_at == null && ['active', 'lent'].includes(asset.status) && asset.audience === 'household'
      && rule?.enabled && !rule.muted && rule.reaction.notify && commitment && commitment.deleted_at == null && commitment.lifecycle_state === 'pending'
      ? { row, asset, rule, commitment } : null;
  };
  let running: Promise<void> | undefined;
  const run = async () => {
    if (stops.signal.aborted || deps.isVaultUnlocked?.() === false) return;
    issue(null);
    const selected = settings.homeAssistant(); const selectedScope = selected ? scopeOf(selected) : null;
    const projections = all(); const groups = new Map<string, { binding: Selection; rows: Projection[] }>();
    for (const row of projections.filter(row => !row.withdrawn)) { const group = groups.get(row.scope) ?? { binding: row.binding, rows: [] }; group.rows.push(row); groups.set(row.scope, group); }
    if (selected && !groups.has(selectedScope!)) groups.set(selectedScope!, { binding: selected, rows: [] });
    let writes = 0;
    for (const [scope, group] of groups) {
      if (stops.signal.aborted) return;
      try {
      if (!current(group.binding)) { issue('A previous Home Assistant connection is unavailable; its old items cannot be withdrawn.'); continue; }
      const flags = await features(group.binding); const remote = await items(group.binding);
      if (scope === selectedScope && settings.homeAssistant() && scopeOf(settings.homeAssistant()!) === scope) {
        for (const occurrence of occurrences.all()) if (context(occurrence.id) && !group.rows.some(row => row.occurrence_id === occurrence.id)) {
          const row: Projection = { scope, binding: group.binding, occurrence_id: occurrence.id, marker: `[Recued:${randomUUID()}]`, uid: null, started: false };
          save(row); group.rows.push(row);
        }
      }
      for (const row of group.rows) {
        const matching = row.uid ? remote.filter(item => item.uid === row.uid) : remote.filter(item => item.description?.split('\n')[0] === row.marker);
        if (matching.length > 1) { issue('Duplicate Home Assistant projection markers need review; Recued will not choose a task.'); continue; }
        const item = matching[0]; if (item && !row.uid) { row.uid = item.uid; save(row); }
        const active = settings.homeAssistant(); const allowed = !!active && scopeOf(active) === scope && scope === selectedScope;
        // D-325 §15.7 (2026-10-24) — the household only receives: a task ticked off on
        // the list changes nothing in Recued.
        if (!allowed || !context(row.occurrence_id)) {
          if (!item && !row.started) { row.withdrawn = true; save(row); continue; }
          if (!item && row.started && !row.uid) { issue('An earlier to-do write is uncertain. Recued is waiting for its original marker, without sending another copy.'); continue; }
          if (item) { if (writes >= 16) continue; if (!(flags & 2)) { issue('The to-do list cannot remove old projections.'); continue; }
            writes++; await request(group.binding, '/api/services/todo/remove_item', { entity_id: group.binding.entity_id, item: item.uid }); }
          row.withdrawn = true; save(row);
          continue;
        }
        const live = context(row.occurrence_id)!;
        const due = live.commitment.promised_for_at === undefined ? undefined : new Date(live.commitment.promised_for_at).toISOString().slice(0, 10);
        const description = `${row.marker}\nDisplay only. Complete this task in Recued.`;
        // The note is compared too, so a task posted with an older one ("Done closes the
        // original task in Recued") is rewritten where the list lets Recued edit it.
        const content = JSON.stringify([live.commitment.statement, due, description]);
        if (!item) {
          if (row.started) { issue('A to-do write is uncertain. Recued is waiting for its original marker, without sending another copy.'); continue; }
          if (writes >= 16) continue;
          if ((flags & (1 | 2 | 64)) !== (1 | 2 | 64)) { issue('Use a list that can create and remove items and keep descriptions; those are required to recover without duplicates.'); continue; }
          writes++;
          await request(group.binding, '/api/services/todo/add_item', { entity_id: group.binding.entity_id, item: live.commitment.statement, description,
            ...(due && flags & 16 ? { due_date: due } : {}) }, () => !!context(row.occurrence_id) && !!settings.homeAssistant() && scopeOf(settings.homeAssistant()!) === scope,
            () => { row.started = true; save(row); });
          row.content = content; save(row);
        } else if (row.content !== content && writes < 16 && flags & 4) {
          writes++; await request(group.binding, '/api/services/todo/update_item', { entity_id: group.binding.entity_id, item: item.uid,
            rename: live.commitment.statement, description, ...(due && flags & 16 ? { due_date: due } : {}) }, () => !!context(row.occurrence_id) && !!settings.homeAssistant() && scopeOf(settings.homeAssistant()!) === scope); row.content = content; save(row);
        }
      }
      } catch (error) { note(error instanceof Error ? error.message : 'Home Assistant is unavailable'); }
    }
  };
  const project = () => running ??= run().catch(error => { note(error instanceof Error ? error.message : 'Home Assistant is unavailable'); }).finally(() => { running = undefined; });
  /** A pass, settled no later than `STOP_GRACE_MS` after `stop`: the asset
   *  reminders' tick waits for it, and a drain waits for that. The pass goes on. */
  const tick = (): Promise<void> => {
    // Stopped: no new pass, and the one in progress is `stop`'s to wait for.
    if (stops.signal.aborted) return Promise.resolve();
    return releasedAtStop(project(), stops.signal, undefined);
  };
  let configuring = 0;
  return {
    tick,
    /** Start no request, end the reads in flight, and wait for the pass in
     *  progress at most `STOP_GRACE_MS`; a write in flight is left to finish
     *  (`stops`). Idempotent. */
    async stop(): Promise<void> {
      stops.abort();
      if (running) await settleWithin(running, STOP_GRACE_MS);
    },
    read() { return { selection: settings.homeAssistant(), connections: deps.connections().filter(row => homeAssistantBaseUrl(row))
        .map(row => ({ name: row.name, enrolled_at: row.enrolled_at, ...(row.display_name ? { display_name: row.display_name } : {}) })),
      issue: (deps.db.prepare('SELECT issue FROM household_ha_status WHERE id=1').get() as { issue: string | null } | undefined)?.issue ?? null,
      uncertain: all().filter(row => !row.withdrawn && row.started && !row.uid).length }; },
    writerConnections(): AssetWriterConnection[] {
      return deps.connections().filter(row => homeAssistantBaseUrl(row)).map(row => ({ name: row.name,
        label: row.display_name || row.name, enrolled_at: row.enrolled_at, revision: connectionRevision(connectionIdentity(row, deps.authSourceId?.(row.name)))! }));
    },
    async writerSources(connection: AssetWriterConnection): Promise<{ sources: AssetWriterSource[]; sources_truncated: boolean }> {
      const row = deps.connections().find(row => row.name === connection?.name && row.enrolled_at === connection.enrolled_at);
      const base = row && homeAssistantBaseUrl(row);
      const valid = () => deps.connections().some(current => current.name === connection?.name
        && connectionRevision(connectionIdentity(current, deps.authSourceId?.(current.name))) === connection.revision);
      if (!row || !base || !valid()) throw new Error('This Home Assistant connection changed. Choose it again.');
      const binding: Selection = { connection_name: row.name, connection_enrolled_at: row.enrolled_at, base_url: base, entity_id: '', selected_at: now() };
      const states = await request(binding, '/api/states', undefined, valid, undefined, listReading);
      if (!valid()) throw new Error('This Home Assistant connection changed while devices were being read. Choose it again.');
      if (!Array.isArray(states)) throw new Error('Home Assistant returned no devices');
      const sources = states.flatMap(value => { const source = writerSource(value); return source ? [source] : []; })
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      return { sources: sources.slice(0, 1000), sources_truncated: sources.length > 1000 };
    },
    /** §15.7 amendment — the to-do lists this connection offers, so the owner picks one by
     *  name. Each says whether Recued can use it, by the features `configure` requires. */
    async lists(input: { connection_name: string; connection_enrolled_at: number }): Promise<{ lists: HouseholdHomeAssistantList[] }> {
      if (deps.isVaultUnlocked?.() === false) throw new Error('Unlock the vault to read Home Assistant');
      const row = deps.connections().find(row => row.name === input?.connection_name && row.enrolled_at === input.connection_enrolled_at);
      const base = row ? homeAssistantBaseUrl(row) : null;
      if (!row || !base) throw new Error('Choose an enrolled Home Assistant connection');
      const binding: Selection = { connection_name: row.name, connection_enrolled_at: row.enrolled_at, base_url: base, entity_id: '', selected_at: now() };
      const states = await request(binding, '/api/states', undefined, undefined, undefined, listReading) as unknown;
      if (!Array.isArray(states)) throw new Error('Home Assistant returned no entities');
      const lists = states.flatMap((state): HouseholdHomeAssistantList[] => {
        const entity_id = (state as { entity_id?: unknown } | null)?.entity_id;
        if (typeof entity_id !== 'string' || !TODO_ENTITY_ID.test(entity_id)) return [];
        const { state: status, attributes } = state as { state?: unknown; attributes?: { friendly_name?: unknown; supported_features?: unknown } };
        const label = typeof attributes?.friendly_name === 'string' && attributes.friendly_name.trim() ? attributes.friendly_name.trim().slice(0, 200) : entity_id;
        const flags = Number.isSafeInteger(attributes?.supported_features) && Number(attributes!.supported_features) >= 0 ? Number(attributes!.supported_features) : 0;
        const missing = REQUIRED_FEATURES.filter(([flag]) => !(flags & flag)).map(([, words]) => words);
        const reason = status === 'unavailable' || status === 'unknown' ? 'isn’t available right now' : missing.length ? missing.join(' and ') : undefined;
        return [{ entity_id, name: label, usable: reason === undefined, ...(reason ? { reason } : {}) }];
      });
      return { lists: lists.sort((a, b) => a.name.localeCompare(b.name) || a.entity_id.localeCompare(b.entity_id)).slice(0, 200) };
    },
    async configure(input: { connection_name: string | null; connection_enrolled_at?: number; entity_id?: string }) {
      const revision = ++configuring;
      if (deps.isVaultUnlocked?.() === false) throw new Error('Unlock the vault to configure Home Assistant');
      if (input.connection_name === null) { settings.setHomeAssistant(null); await tick(); return; }
      const row = deps.connections().find(row => row.name === input.connection_name && row.enrolled_at === input.connection_enrolled_at);
      const base = row ? homeAssistantBaseUrl(row) : null;
      if (!row || !base || typeof input.entity_id !== 'string' || !TODO_ENTITY_ID.test(input.entity_id)) throw new Error('Choose an enrolled Home Assistant connection and one to-do entity id');
      const candidate: Selection = { connection_name: row.name, connection_enrolled_at: row.enrolled_at, base_url: base, entity_id: input.entity_id, selected_at: now() };
      const flags = await features(candidate);
      if (REQUIRED_FEATURES.some(([flag]) => !(flags & flag))) throw new Error('This list must support creating and removing items and keeping their descriptions');
      await items(candidate);
      // The same list saved again keeps the selection stored for it, as it was stored (one
      // saved before 2026-10-24 also carries a `mode`): its tasks' scope is a hash of it, so
      // they stay where they are rather than being removed and posted again.
      const old = settings.homeAssistant();
      const next = old && old.connection_name === candidate.connection_name && old.connection_enrolled_at === candidate.connection_enrolled_at
        && old.base_url === candidate.base_url && old.entity_id === candidate.entity_id ? old : candidate;
      if (revision !== configuring || !current(next) || deps.isVaultUnlocked?.() === false) throw new Error('Home Assistant changed while checking the selected list');
      settings.setHomeAssistant(next); issue(null); await tick();
    },
  };
};
export type HouseholdHomeAssistant = ReturnType<typeof createHouseholdHomeAssistant>;
