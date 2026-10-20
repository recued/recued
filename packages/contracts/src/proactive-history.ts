import type { AssetEvidence, AssetRule, Sphere } from './assets.js';
import { isAssetDate } from './assets.js';
import type { SituationBasis, SituationPlace, SituationRef, SituationWindow } from './situation.js';

export interface Episode {
  id: string;
  title: string;
  when: SituationWindow;
  where?: SituationPlace;
  people: string[];
  subjects: SituationRef[];
  evidence: AssetEvidence[];
  basis: SituationBasis;
  class_id?: string;
  notes?: string;
  occasion_id?: string;
  /** Versioned assembly rule, so an owner correction scores that rule. */
  assembly_rule?: 'owner_record.v1' | 'plan_trace.v1' | 'trace_only.v1';
  sphere?: Sphere;
  sensitive: Array<'health' | 'pregnancy' | 'money_under_stress' | 'relationships'>;
  storage_reason: 'owner_record' | 'owner_correction' | 'owner_annotation' | 'proposal_citation' | 'recurrence';
  created_at: number;
  updated_at: number;
}
export type EpisodeInput = Omit<Episode, 'id' | 'created_at' | 'updated_at'> & { id?: string };
export interface RetainedHistoryEvidence {
  id: string; title: string; when: SituationWindow; people: string[]; where?: SituationPlace;
  class_id: string; sources: SituationRef[]; retained_at?: number; source_mailbox?: string;
}
export interface Occasion {
  id: string;
  title: string;
  class_id?: string;
  /** An annual date. Its year is computed at read time, never rolled forward
   * in storage. February 29 waits for a real leap day. */
  month_day: string;
  people: string[];
  where?: SituationPlace;
  source?: SituationRef;
  /** Host source reconciliation can suspend a removed/hidden source without
   * changing the owner's mute choice or overwriting an owner-edited series. */
  source_active?: boolean;
  source_pinned?: boolean;
  /** Expanded calendar series use their actual next instance. Null means no
   * future instance is known; it must not fall back to an invented recurrence. */
  source_next_on?: string | null;
  sphere?: Sphere;
  muted: boolean;
  /** Rows on next_on, with the same closed grammar as asset clocks. */
  rules: AssetRule[];
  created_at: number;
  updated_at: number;
}
export type OccasionInput = Omit<Occasion, 'id' | 'created_at' | 'updated_at'> & { id?: string };
/** P27 — an occasion rings every year: one on 29 February falls on 28 February in
 * a common year, rather than going silent three years in four. */
export const nextAnnualDate = (month_day: string, from: string): string | null => {
  const suffix = month_day.startsWith('--') ? month_day.slice(2) : month_day;
  if (!/^\d{2}-\d{2}$/u.test(suffix) || !isAssetDate(`2000-${suffix}`) || !isAssetDate(from)) return null;
  const year = Number(from.slice(0, 4));
  for (let next = year; next <= Math.min(9999, year + 8); next += 1) {
    const exact = `${String(next).padStart(4, '0')}-${suffix}`;
    const date = isAssetDate(exact) ? exact : suffix === '02-29' ? `${String(next).padStart(4, '0')}-02-28` : null;
    if (date !== null && date >= from) return date;
  }
  return null;
};
export const occasionNextDate = (occasion: Pick<Occasion, 'month_day' | 'source_next_on'>, from: string): string | null =>
  occasion.source_next_on !== undefined ? (occasion.source_next_on !== null && isAssetDate(occasion.source_next_on) && occasion.source_next_on >= from ? occasion.source_next_on : null)
    : nextAnnualDate(occasion.month_day, from);
