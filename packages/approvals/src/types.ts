import type {
  ApprovalRequest, ApprovalResponse,
  RecipeTrustState, SessionApproval, BackgroundConsent, PendingAction,
  RiskTier,
} from '@recued/contracts';

/** The provider that prompts the user for an approval decision.
 *  In production: shows a modal in the sidebar.
 *  In tests: returns a hardcoded response.
 */
export interface ApprovalProvider {
  prompt(request: ApprovalRequest): Promise<ApprovalResponse>;
}

/** Persisted trust state per recipe. Synced across instances by default (Pro). */
export interface TrustStateStore {
  get(recipe_id: string): Promise<RecipeTrustState | null>;
  set(state: RecipeTrustState): Promise<void>;
  /** Remove trust state for a recipe (e.g. on uninstall). */
  delete(recipe_id: string): Promise<void>;
  /** Increment the approval counter for a recipe + tier. Creates the record if missing. */
  increment(recipe_id: string, recipe_version: number, tier: 'write' | 'admin'): Promise<RecipeTrustState>;
  /** Mark a tier as auto-trusted (user clicked "Always allow"). */
  setAuto(recipe_id: string, recipe_version: number, tier: 'write' | 'admin'): Promise<RecipeTrustState>;
}

/** In-memory session approval store. Wiped on browser restart per D-040. */
export interface SessionStore {
  add(approval: SessionApproval): void;
  isValid(recipe_id: string, tier: RiskTier): boolean;
  remove(recipe_id: string, tier: RiskTier): void;
  clear(): void;
}

/** Persisted queue of actions deferred from scheduled execution. */
export interface PendingQueue {
  add(action: PendingAction): Promise<void>;
  list(): Promise<PendingAction[]>;
  remove(pending_id: string): Promise<void>;
  removeByRecipe(recipe_id: string): Promise<number>;
}

/** Lookup function — engine knows how to load manifests. */
export type ManifestLookup = (slug: string) => Promise<{ category: string; risk_tier: RiskTier } | null>;
