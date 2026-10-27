import type { AuthorizationProvenance } from './ingredient-catalog.js';

/** A recipe may describe narrow local writes for owner review. The declaration
 * grants nothing; a paired owner authorizes one schedule and its current data. */
export interface LocalAutomationScope {
  catalog: string;
  entity: string;
  connection_slot: string;
  connection_field: string;
  filters?: Record<string, string>;
  mutable_fields: string[];
  asset?: { id_field: string; date_fields: string[]; source_ref_prefix: string };
}
export interface LocalAutomationReview {
  schedule_id: string;
  supported: boolean;
  reason?: string;
  recipe_name?: string;
  review_id?: string;
  records?: Array<{ id: string; values: Record<string, unknown>; asset_id?: string }>;
  record_fields?: string[];
  asset_fields?: string[];
  connection?: string;
  authorization?: { expires_at: number; uses_remaining: number; current: boolean };
}

/** Host-only authority. Wire arguments and recipe data cannot make a permit. */
export interface LocalAutomationHooks {
  authorize(call: { slug: string; input: Record<string, unknown>; risk_tier: string;
    provenance: AuthorizationProvenance }): object | undefined;
  run<T>(permit: object, effect: () => T): T;
}
