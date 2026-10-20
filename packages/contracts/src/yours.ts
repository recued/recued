import type { Asset, AssetClassPreset, AssetCreateInput, AssetPatch, AssetRule, Sphere } from './assets.js';
import type { Commitment } from './work-entities.js';
import type { SituationDismissal, SituationRef, SituationResult } from './situation.js';
import type { Episode, EpisodeInput, Occasion, OccasionInput, RetainedHistoryEvidence } from './proactive-history.js';
import type { AssetDocumentDetails } from './asset-documents.js';

export const PROACTIVE_PROPOSAL_KINDS = ['asset', 'link', 'merge', 'close', 'rule', 'schedule', 'occasion', 'last_done', 'trip', 'recall', 'completion', 'ranking', 'relation', 'habit'] as const;
export type ProactiveProposalKind = typeof PROACTIVE_PROPOSAL_KINDS[number];
export type ProactiveProposalLane = 'likely_asset' | 'gift' | 'return' | 'pickup' | 'bundle';
export interface ProactiveProposal {
  id: string;
  key: string;
  kind: ProactiveProposalKind;
  title: string;
  explanation: string;
  state: 'proposed' | 'accepted' | 'dismissed' | 'retracted';
  payload: Record<string, unknown>;
  sources: SituationRef[];
  confidence: 'high' | 'medium' | 'low';
  lane?: ProactiveProposalLane;
  merchant?: string;
  subject?: SituationRef;
  origin: 'intake' | 'owner' | 'learner' | 'pack';
  result?: SituationRef;
  dismissal?: SituationDismissal | 'not_an_asset';
  created_at: number;
  updated_at: number;
  edited_at?: number;
  shown_at?: number;
}
export type ProactiveProposalInput = Pick<ProactiveProposal, 'key' | 'kind' | 'title' | 'explanation' | 'payload' | 'sources' | 'confidence' | 'origin'>
  & Partial<Pick<ProactiveProposal, 'lane' | 'merchant' | 'subject'>>;
export interface ProactiveSuppression {
  id: string;
  kind: 'person' | 'place' | 'date_range' | 'episode' | 'proposal_kind' | 'merchant';
  value?: string;
  from?: number;
  to?: number;
  created_at: number;
  /** A hidden or deleted episode's title, so its exclusion is listed by name. */
  label?: string;
  /** On a row that stands for one item of a hidden episode's evidence: that episode's
   *  id. It is listed with, and removed with, the episode's own row. */
  of?: string;
}
export interface YoursOccurrence {
  id: string;
  asset_id: string;
  subject_kind?: 'asset' | 'occasion';
  rule_id: string;
  /** The commitment's statement, or the subject and rule for a notice. */
  title: string;
  /** The day it falls due, when the clock knows one. */
  due_on: string | null;
  question: boolean;
  commitment: Commitment | null;
  current_ask_id: string | null;
  later_until: number | null;
  /** A forwarded proof can propose closing it (§5.3): an open action of an
   *  expiry or interval rule. Absent otherwise, and from an older server. */
  closes_by_proof?: true;
}
export interface YoursSourceControl { id: string; name: string; enabled: boolean; proposals: number }
export type YoursAssetFilter = 'missing_facts' | 'overdue';
export type YoursAssetSphere = Sphere | 'unsorted';
/** Read-only projection of the displayed asset's rules and canonical tasks. */
export interface YoursAssetSummary {
  asset_id: string;
  open_tasks: number;
  active_rules: number;
  /** Earliest unsettled due day, including an overdue obligation. */
  next_due: { on: string; title: string; rule_id: string; commitment_id?: string;
    state: 'overdue' | 'today' | 'upcoming'; estimated: boolean } | null;
  missing: Array<{ path: `${'dates' | 'readings' | 'observations'}.${string}`;
    reason: 'unknown' | 'future' | 'unconfirmed' }>;
}
export interface HouseholdTelegramSelection {
  connection_name: string; connection_enrolled_at: number; recipient: string; expected_sender: string; members: string[]; selected_at: number;
}
export interface HouseholdHomeAssistantSelection {
  connection_name: string; connection_enrolled_at: number; base_url: string; entity_id: string;
  mode: 'interactive' | 'display_only'; selected_at: number;
}
/** A "last time" class's measured dark run (§9) and the owner's bar for it (P11). */
export interface YoursRecallRate { class_id: string; scored: number; relevant: number; rate: number; minimum_rate: number | null; qualified: boolean }
/** §15.7 — what Settings → Privacy → Learning shows of "last time" (P21), read
 * without the refreshes a Yours snapshot runs. */
export interface YoursLearningStatus {
  last_time: 'unasked' | 'on' | 'off';
  /** The once-only question waits in the bell. */
  asked: boolean;
  classes: YoursRecallRate[];
}
export interface YoursSnapshot {
  assets: Asset[];
  /** §15.3 — the open asset's holder by name; `name` is null for a contact no longer
   *  on file. Absent for a list, an asset with no holder, and from an older server. */
  holder?: { contact_id: string; name: string | null };
  /** Summaries cover only assets on this page; older servers may omit them. */
  asset_summaries?: YoursAssetSummary[];
  related_assets: Asset[];
  /** Matching assets before pagination, including search, attention and sphere filters. */
  total_assets: number;
  /** Echoes an applied filter. Unreadable summaries are excluded and counted. */
  asset_filter?: { kind: YoursAssetFilter; unavailable: number };
  /** Echoes the applied resolved-sphere filter; older servers may omit it. */
  asset_sphere?: YoursAssetSphere;
  classes: AssetClassPreset[];
  proposals: ProactiveProposal[];
  total_proposals: number;
  matching_proposals?: number;
  occurrences: YoursOccurrence[];
  /** The `+done` address of each mailbox whose mail can propose: forwarding the
   *  email that proves a renewal or service there, from that mailbox, proposes
   *  closing its open task. Absent from an older server. */
  proof_addresses?: string[];
  occasions: Occasion[];
  episodes: Episode[];
  derived_episodes?: EpisodeInput[];
  recall_rates?: YoursRecallRate[];
  history_receipts?: Array<{ mailbox: string; cutoff: number; at: number; candidates: number }>;
  history_evidence?: RetainedHistoryEvidence[];
  household?: { telegram: HouseholdTelegramSelection | null; telegram_connections: Array<{ name: string; enrolled_at: number; recipient: string; owner_sender: string }>;
    home_assistant?: { selection: HouseholdHomeAssistantSelection | null; connections: Array<{ name: string; enrolled_at: number }>; issue: string | null; uncertain: number } };
  sources: YoursSourceControl[];
  suppressions: ProactiveSuppression[];
  /** §15.4 — what the owner hid from Today and the brief, to restore. */
  situation_dismissals?: Array<{ key: string; scope: 'item' | 'kind'; code: Exclude<SituationDismissal, 'wrong'>; label: string; kind: string; until: number | null; at: number }>;
  intake: { emails_read: number; receipts_found: number; likely_assets: number; last_scan_at: number | null };
  unmatched_replies: Array<{ id: string; text: string; reason: string; created_at: number }>;
  subscriber_issues?: Array<{ subscriber_id: string; revision: number; run_id: string; state: string; at: number }>;
  subscribers?: Array<{ trigger_id: string; recipe_id: string; pattern: string; contract_id?: string }>;
  subscriber_contracts?: Array<{ id: string; name: string }>;
  observation_recipes?: Array<{ id: string; name: string; publisher: string; hash: string }>;
  observation_bindings?: Array<{ id: string; asset_id: string; actor_ref: string; source_ref: string; fields: string[]; enabled: boolean; available?: boolean; recipe_hash?: string }>;
  observation_handoffs?: Array<{ id: string; path: string; at: number;
    value: Asset['readings'][string] | Asset['observations'][string]; source: Asset['field_sources'][string] }>;
  phone_ready: boolean;
  settings: { digest: 'daily' | 'weekly' | 'off'; last_time: 'unasked' | 'on' | 'off'; measures: boolean };
  situations?: SituationResult;
  delivery?: import('./situation.js').SituationDeliveryStatus;
  sphere_placements: Array<{ ref: SituationRef; sphere?: Sphere; reason: string; pinned: boolean; source?: string }>;
  sphere_sources?: Array<{ source: string; name: string; sphere?: Sphere }>;
  retirement_impact?: { parts: number; contracts: number; open_occurrences: number };
}
export interface YoursReadRequest { asset_id?: string; occasion_id?: string; episode_id?: string; contact_id?: string; trace_id?: string; include_derived?: boolean; search?: string; asset_filter?: YoursAssetFilter; asset_sphere?: YoursAssetSphere; offset?: number; limit?: number; proposal_offset?: number; proposal_kind?: ProactiveProposalKind; include_closed?: boolean; include_asset_summaries?: boolean; mark_shown?: boolean }
export interface YoursSpherePlacement { sphere?: Sphere; reason: string; pinned: boolean; source?: string }
/** Owner UI controls. Grant creation remains in Contracts. These commands
 * cannot run recipes, mint grants, or accept a standing delegation. */
export type YoursCommand =
  | { action: 'asset.create'; input: Omit<AssetCreateInput, 'source'>; class_id?: string }
  | { action: 'asset.update'; id: string; patch: AssetPatch; confirm_retirement?: boolean }
  | { action: 'asset.automatic_updates'; id: string; path: string;
    expected: { value: Asset['readings'][string] | Asset['observations'][string]; source: Asset['field_sources'][string] } }
  | { action: 'asset.delete'; id: string; confirmed: boolean }
  | { action: 'asset.link'; id: string; parent_id: string | null }
  | { action: 'asset.same_thing'; id: string; other_id: string; merge: boolean }
  | { action: 'class.save'; preset: AssetClassPreset }
  | { action: 'class.delete'; id: string }
  | { action: 'class.apply'; asset_id: string; class_id: string }
  | { action: 'proposal.create'; proposal: ProactiveProposalInput }
  | { action: 'proposal.edit'; id: string; title?: string; payload?: Record<string, unknown> }
  | { action: 'proposal.accept'; ids: string[] }
  | { action: 'proposal.dismiss'; id: string; code: SituationDismissal | 'not_an_asset'; correction?: { asset_id: string; patch: AssetPatch }; episode_correction?: EpisodeInput }
  | { action: 'proposal.delete'; id: string }
  | { action: 'source.set'; id: string; enabled: boolean }
  | { action: 'merchant.stop'; merchant: string }
  | { action: 'intake.forget'; confirmed: boolean }
  | { action: 'intake.scan' }
  | { action: 'occurrence.last_done'; id: string; on: string | null }
  | { action: 'occurrence.later'; id: string; until: number }
  | { action: 'rule.save'; asset_id: string; rule: AssetRule; confirm_floor_mute?: boolean }
  | { action: 'rule.delete'; asset_id: string; rule_id: string; confirm_floor_delete?: boolean }
  | { action: 'suppression.save'; suppression: Omit<ProactiveSuppression, 'id' | 'created_at'> }
  | { action: 'suppression.delete'; id: string }
  | { action: 'sphere.source'; source: string; sphere: Sphere | null }
  | { action: 'sphere.item'; ref: SituationRef; sphere: Sphere | null }
  | { action: 'unmatched.dismiss'; id: string }
  | { action: 'occasion.save'; occasion: OccasionInput; confirm_floor_mute?: boolean }
  | { action: 'occasion.delete'; id: string; confirm_floor_delete?: boolean }
  | { action: 'episode.save'; episode: EpisodeInput }
  | { action: 'episode.delete'; id: string; suppress?: boolean }
  /** P44 — hide an episode where it is cited, stored or assembled: it is never shown
   *  or suggested from again (P17) until its exclusion is removed. */
  | { action: 'episode.hide'; id: string }
  | { action: 'recall.class'; class_id: string; minimum_rate: number }
  | { action: 'history.forget'; confirmed: boolean }
  | { action: 'household.telegram'; connection_name: string | null; connection_enrolled_at?: number; members?: string[] }
  | { action: 'household.home_assistant'; connection_name: string | null; connection_enrolled_at?: number; entity_id?: string }
  | { action: 'place.save'; name: string; key?: string; aliases: string[] }
  /** `from: 'today'` — the owner opened an item Today showed, which the learner counts
   *  as acting on its kind (D-325 §8). */
  | { action: 'navigation.open'; ref: SituationRef; from?: 'today' }
  /** §15.4 — a coded answer to an item Recued put in a cluster, from Today. */
  | { action: 'situation.dismiss'; ref: SituationRef; kind: string; code: SituationDismissal; label: string }
  | { action: 'situation.restore'; key: string }
  | { action: 'trip.save'; trip: import('./situation.js').TripDetails }
  | { action: 'binding.save'; asset_id: string; recipe_id: string; fields: string[] }
  | { action: 'binding.disable'; asset_id: string; id: string }
  | { action: 'file.attach'; asset_id: string; record_id: string }
  | { action: 'file.details'; asset_id: string; link_id: string; record_id: string; details: AssetDocumentDetails }
  | { action: 'file.detach'; asset_id: string; link_id: string; record_id: string }
  | { action: 'delivery.update'; settings: Partial<import('./situation.js').SituationDeliverySettings> }
  | { action: 'delivery.send_now' }
  | { action: 'subscriber.reconciled'; subscriber_id: string; revision: number; run_id: string }
  | { action: 'subscriber.contract'; trigger_id: string; contract_id: string | null }
  | { action: 'settings.update'; digest?: 'daily' | 'weekly' | 'off'; last_time?: 'on' | 'off'; measures?: boolean };
export interface YoursCommandResult { message: string; id?: string; changed?: number; failed?: Array<{ id: string; reason: string }> }
