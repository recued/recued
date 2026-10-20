import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ConnectionRow, HouseholdHomeAssistantSelection } from '@recued/contracts';
import type { WorkEntityStore } from '../storage/work-entity-store.js';
import { createAssetOccurrenceStore } from '../storage/asset-occurrence-store.js';
import { createHouseholdDeliveryStore } from '../storage/household-delivery-store.js';
import { makeBoundedOriginHttpFetcher, type BoundedHttpFetcher } from '../bounded-origin-http-fetcher.js';
import type { AssetOccurrenceService } from './asset-occurrence-service.js';

type Selection = HouseholdHomeAssistantSelection;
type Projection = { scope: string; occurrence_id: string; binding: Selection; marker: string; uid: string | null;
  started: boolean; completed_seen_at?: number; withdrawn?: boolean; content?: string };
type TodoItem = { uid: string; summary: string; status: 'needs_action' | 'completed'; description?: string };
export const homeAssistantBaseUrl = (row: ConnectionRow): string | null => {
  if (row.kind !== 'api') return null;
  try { const raw = JSON.parse(row.config_json).base_url; if (typeof raw !== 'string') return null;
    const url = new URL(raw); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return url.href.replace(/\/+$/u, '');
  } catch { return null; }
};
const scopeOf = (value: Selection) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface HouseholdHomeAssistantDeps {
  db: Database.Database; work: WorkEntityStore; occurrences: AssetOccurrenceService;
  /** Only connections bound to the installed Home Assistant catalog. */
  connections(): readonly ConnectionRow[];
  credential(row: ConnectionRow): Promise<string | null>;
  isVaultUnlocked?(): boolean; now?(): number; fetch?: BoundedHttpFetcher;
}
/** A projection ledger holds provider identities and uncertain writes only.
 * Lifecycle and deadlines always come from the original commitment. */
export const createHouseholdHomeAssistant = (deps: HouseholdHomeAssistantDeps) => {
  const settings = createHouseholdDeliveryStore(deps.db); const occurrences = createAssetOccurrenceStore(deps.db);
  const now = deps.now ?? Date.now; const fetcher = deps.fetch ?? makeBoundedOriginHttpFetcher({ timeoutMs: 5000, maxResponseBytes: 2_000_000, redirectPolicy: 'error' });
  deps.db.exec(`CREATE TABLE IF NOT EXISTS household_ha_projections(scope TEXT NOT NULL,occurrence_id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(scope,occurrence_id));
    CREATE TABLE IF NOT EXISTS household_ha_status(id INTEGER PRIMARY KEY CHECK(id=1),issue TEXT);`);
  const save = (row: Projection) => deps.db.prepare('INSERT INTO household_ha_projections(scope,occurrence_id,value) VALUES(?,?,?) ON CONFLICT(scope,occurrence_id) DO UPDATE SET value=excluded.value')
    .run(row.scope, row.occurrence_id, JSON.stringify(row));
  const all = (): Projection[] => (deps.db.prepare('SELECT value FROM household_ha_projections ORDER BY scope,occurrence_id').all() as { value: string }[]).map(row => JSON.parse(row.value));
  const issue = (text: string | null) => { deps.db.prepare('INSERT INTO household_ha_status(id,issue) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET issue=excluded.issue').run(text); };
  const current = (binding: Selection): ConnectionRow | undefined => deps.connections().find(row => row.name === binding.connection_name
    && row.enrolled_at === binding.connection_enrolled_at && homeAssistantBaseUrl(row) === binding.base_url);
  const request = async (binding: Selection, path: string, body?: Record<string, unknown>, guard?: () => boolean, beforeSend?: () => void) => {
    if (deps.isVaultUnlocked?.() === false) throw new Error('Unlock the vault to reach Home Assistant');
    const row = current(binding); if (!row) throw new Error('The selected Home Assistant connection is unavailable');
    const token = await deps.credential(row);
    if (!token || !current(binding) || deps.isVaultUnlocked?.() === false || guard?.() === false) throw new Error('The Home Assistant projection changed before delivery');
    beforeSend?.();
    const response = await fetcher(`${binding.base_url}${path}`, { method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!current(binding) || deps.isVaultUnlocked?.() === false) throw new Error('Home Assistant connection changed during the request');
    if (!response.ok) throw new Error(`Home Assistant returned ${response.status}`);
    return response.json();
  };
  const features = async (binding: Selection): Promise<number> => {
    const state = await request(binding, `/api/states/${encodeURIComponent(binding.entity_id)}`) as { entity_id?: string; state?: string; attributes?: { supported_features?: unknown } };
    const flags = state?.attributes?.supported_features;
    if (state?.entity_id !== binding.entity_id || ['unavailable', 'unknown'].includes(state.state ?? '') || !Number.isSafeInteger(flags) || Number(flags) < 0) throw new Error('The selected to-do list is unavailable');
    return Number(flags);
  };
  const items = async (binding: Selection): Promise<TodoItem[]> => {
    const response = await request(binding, '/api/services/todo/get_items?return_response', { entity_id: binding.entity_id, status: ['needs_action', 'completed'] }) as { service_response?: Record<string, { items?: unknown }> };
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
    if (deps.isVaultUnlocked?.() === false) return;
    issue(null);
    const selected = settings.homeAssistant(); const selectedScope = selected ? scopeOf(selected) : null;
    const projections = all(); const groups = new Map<string, { binding: Selection; rows: Projection[] }>();
    for (const row of projections.filter(row => !row.withdrawn)) { const group = groups.get(row.scope) ?? { binding: row.binding, rows: [] }; group.rows.push(row); groups.set(row.scope, group); }
    if (selected && !groups.has(selectedScope!)) groups.set(selectedScope!, { binding: selected, rows: [] });
    let writes = 0;
    for (const [scope, group] of groups) {
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
        const value = allowed ? context(row.occurrence_id) : null;
        if (value && group.binding.mode === 'interactive' && (item?.status === 'completed' || row.completed_seen_at)) {
          if (!(flags & 4)) { issue('This to-do list no longer supports completion updates; it is display-only.'); continue; }
          row.completed_seen_at ??= now(); save(row);
          await deps.occurrences.completeOccurrence({ occurrence_id: row.occurrence_id, answered_at: row.completed_seen_at, actual_time_unknown: true });
        }
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
        const content = JSON.stringify([live.commitment.statement, due]);
        const description = `${row.marker}\n${group.binding.mode === 'display_only' ? 'Display only. Complete this task in Recued.' : 'Done closes the original task in Recued. Service dates and readings are confirmed separately.'}`;
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
      } catch (error) { issue(error instanceof Error ? error.message : 'Home Assistant is unavailable'); }
    }
  };
  const tick = () => running ??= run().catch(error => { issue(error instanceof Error ? error.message : 'Home Assistant is unavailable'); }).finally(() => { running = undefined; });
  let configuring = 0;
  return {
    tick,
    read() { return { selection: settings.homeAssistant(), connections: deps.connections().filter(row => homeAssistantBaseUrl(row)).map(row => ({ name: row.name, enrolled_at: row.enrolled_at })),
      issue: (deps.db.prepare('SELECT issue FROM household_ha_status WHERE id=1').get() as { issue: string | null } | undefined)?.issue ?? null,
      uncertain: all().filter(row => !row.withdrawn && row.started && !row.uid).length }; },
    async configure(input: { connection_name: string | null; connection_enrolled_at?: number; entity_id?: string }) {
      const revision = ++configuring;
      if (deps.isVaultUnlocked?.() === false) throw new Error('Unlock the vault to configure Home Assistant');
      if (input.connection_name === null) { settings.setHomeAssistant(null); await tick(); return; }
      const row = deps.connections().find(row => row.name === input.connection_name && row.enrolled_at === input.connection_enrolled_at);
      const base = row ? homeAssistantBaseUrl(row) : null;
      if (!row || !base || typeof input.entity_id !== 'string' || !/^todo\.[a-z0-9_]{1,200}$/u.test(input.entity_id)) throw new Error('Choose an enrolled Home Assistant connection and one to-do entity id');
      const candidate: Selection = { connection_name: row.name, connection_enrolled_at: row.enrolled_at, base_url: base, entity_id: input.entity_id, mode: 'interactive', selected_at: now() };
      const flags = await features(candidate);
      if ((flags & (1 | 2 | 64)) !== (1 | 2 | 64)) throw new Error('This list must support creating and removing items and keeping their descriptions');
      await items(candidate); candidate.mode = flags & 4 ? 'interactive' : 'display_only';
      const old = settings.homeAssistant();
      if (old && old.connection_name === candidate.connection_name && old.connection_enrolled_at === candidate.connection_enrolled_at
        && old.base_url === candidate.base_url && old.entity_id === candidate.entity_id && old.mode === candidate.mode) candidate.selected_at = old.selected_at;
      if (revision !== configuring || !current(candidate) || deps.isVaultUnlocked?.() === false) throw new Error('Home Assistant changed while checking the selected list');
      settings.setHomeAssistant(candidate); issue(null); await tick();
    },
  };
};
export type HouseholdHomeAssistant = ReturnType<typeof createHouseholdHomeAssistant>;
