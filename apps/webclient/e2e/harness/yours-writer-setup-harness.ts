import { bootstrapYoursRoute } from '../../src/yours/bootstrap-yours-route.js';
import type { Asset, AssetWriterReview, AssetWriterSelection, AssetWriterSetupChange, AssetWriterSetupRead, AssetWriterSetupStatus, YoursSnapshot } from '@recued/contracts';

const at = Date.parse('2026-10-26T12:00:00Z');
const asset: Asset = { id: 'hall-alarm', name: 'Hall alarm', source_id: 'recued.asset', sync_state: 'live', conflict_policy: 'manual_merge',
  last_seen_at: at, status: 'active', dates: {}, readings: { battery: null }, observations: { unavailable: null },
  values: [], anchors: [], attributes: {}, settings: {}, rules: [], field_sources: {}, retirement: 'part', created_at: at, updated_at: at };
const snapshot: YoursSnapshot = { assets: [asset], total_assets: 1, related_assets: [], sphere_placements: [], classes: [], proposals: [], total_proposals: 0,
  occurrences: [], occasions: [], episodes: [], sources: [], suppressions: [], intake: { emails_read: 0, receipts_found: 0, likely_assets: 0, last_scan_at: null },
  unmatched_replies: [], phone_ready: false, settings: { digest: 'weekly', last_time: 'off', measures: false } };
let connection = { name: 'house', label: 'Our home', enrolled_at: 100, revision: 'a'.repeat(64) };
const source = { id: 'sensor.hall_alarm_battery', name: 'Hall alarm battery', sample: '84%', fields: ['readings.battery', 'observations.unavailable'] };
const scenario = new URLSearchParams(location.search).get('scenario');
const state: { changes: AssetWriterSetupChange[]; writes: number; setups: AssetWriterSetupStatus[]; lost: boolean } = { changes: [], writes: 0, setups: [], lost: false };
let releasePreview: (() => void) | undefined;
const requests = new Set<string>();
const read = async (input: { asset_id: string; connection?: AssetWriterSelection['connection'] }): Promise<AssetWriterSetupRead> => {
  if (input.connection && input.connection.revision !== connection.revision) throw new Error('The connection changed. Choose it again.');
  return {
  definitions: [{ id: 'home-assistant-device', name: 'Home Assistant device', available: true, fields: source.fields }],
  connections: [connection], ...(input.connection ? { sources: [source] } : {}), setups: structuredClone(state.setups),
  };
};
const change = async (input: AssetWriterSetupChange): Promise<AssetWriterSetupStatus> => {
  state.changes.push(structuredClone(input));
  if (input.action === 'configure') {
    if (!requests.has(input.request_id)) {
      requests.add(input.request_id);
      state.writes++;
      state.setups = [{ id: 'setup-hall-alarm', revision: (state.setups[0]?.revision ?? 0) + 1, name: 'Home Assistant device', source_name: source.name, connection_label: connection.label,
        selection: input.review.selection, fields: input.review.selection.fields, interval_minutes: input.review.selection.interval_minutes,
        state: 'scheduled', scheduled: true, can_resume: true, next_run_at: at + 900_000, last_run: { at, outcome: 'succeeded' },
        deliveries: input.review.selection.fields.map(path => ({ path, delivery: { status: 'recorded', last_submission: {
          at, observation_at: at - 1000, outcome: 'manual_priority' }, last_accepted: { at: at - 3600_000, observation_at: at - 3601_000 } } })) }];
    }
    if ((scenario === 'lost' || scenario === 'lost-update' && state.writes === 2) && !state.lost) { state.lost = true; throw new Error('The reply was lost'); }
  } else {
    const setup = state.setups[0]!;
    if (input.action === 'pause' || input.action === 'resume') { setup.revision++; setup.scheduled = input.action === 'resume'; setup.state = setup.scheduled ? 'scheduled' : 'paused'; }
  }
  return structuredClone(state.setups[0]!);
};
const route = bootstrapYoursRoute({ container: document.querySelector<HTMLElement>('#app')!, segments: ['asset', asset.id],
  read: async () => structuredClone(snapshot), change: async () => ({ message: 'Saved' }), closeCommitment: async () => { throw new Error('Not used'); },
  writerSetup: { read, change, preview: async selection => {
    if (scenario === 'delayed') await new Promise<void>(resolve => { releasePreview = resolve; });
    return { selection, source, asset_name: asset.name, recipe_hash: 'b'.repeat(64), review_hash: 'c'.repeat(64), setup_revision: state.setups[0]?.revision ?? 0 } satisfies AssetWriterReview;
  } } });
document.querySelector<HTMLButtonElement>('#leave')!.onclick = () => route.dispose();
declare global { interface Window { __writerSetup: { state: typeof state; releasePreview(): void; replaceConnection(): void } } }
window.__writerSetup = { state, releasePreview: () => releasePreview?.(), replaceConnection: () => { connection = { ...connection, label: 'Replacement home', enrolled_at: 200, revision: 'd'.repeat(64) }; } };
