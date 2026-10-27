import type { AssetWriterDelivery } from './asset-fact-context.js';

/** A guided setup describes an installed recipe; it grants no access itself. */
export interface AssetWriterSetupDefinition {
  id: string;
  name: string;
  recipe_id: string;
  source: 'home-assistant';
  connection_slot: string;
  asset_variable: string;
  binding_variable: string;
  source_variable: string;
  fields: Readonly<Record<string, string>>;
}

export const HOME_ASSISTANT_WRITER_SETUP: AssetWriterSetupDefinition = {
  id: 'home-assistant-device', name: 'Home Assistant device',
  recipe_id: 'record-device-condition-home-assistant', source: 'home-assistant',
  connection_slot: 'home-assistant', asset_variable: 'asset_id', binding_variable: 'binding_id', source_variable: 'entity_id',
  fields: { 'readings.battery': 'record_battery', 'observations.problem': 'record_problem',
    'observations.unavailable': 'record_unavailable', 'observations.flickering': 'record_flickering' },
};

export interface AssetWriterConnection { name: string; label: string; enrolled_at: number; revision: string }
export interface AssetWriterSource { id: string; name: string; sample: string; fields: string[] }
export interface AssetWriterSelection {
  asset_id: string; definition_id: string; connection: AssetWriterConnection; source_id: string;
  fields: string[]; interval_minutes: number;
}
export interface AssetWriterReview {
  selection: AssetWriterSelection;
  recipe_hash: string;
  review_hash: string;
  setup_revision: number;
  source: AssetWriterSource;
  asset_name: string;
}
export interface AssetWriterSetupStatus {
  id: string; revision: number; name: string; source_name: string; connection_label: string;
  selection: AssetWriterSelection;
  fields: string[]; interval_minutes: number;
  state: 'scheduled' | 'paused' | 'running' | 'needs_review';
  scheduled: boolean;
  can_resume: boolean;
  issue?: string;
  next_run_at?: number;
  last_run?: { at: number; outcome: 'running' | 'succeeded' | 'failed' | 'waiting' | 'skipped' | 'unknown'; message?: string };
  deliveries: Array<{ path: string; delivery: AssetWriterDelivery }>;
}
export interface AssetWriterSetupRead {
  definitions: Array<{ id: string; name: string; fields: string[]; available: boolean }>;
  connections: AssetWriterConnection[];
  sources?: AssetWriterSource[];
  sources_truncated?: boolean;
  setups: AssetWriterSetupStatus[];
}
export type AssetWriterSetupChange =
  | { action: 'configure'; review: AssetWriterReview; request_id: string }
  | { action: 'run' | 'pause' | 'resume'; asset_id: string; setup_id: string; revision: number };
