/** Host-private D-261 data. None of these structures are public RPC inputs. */
import type {
  ExecutionSource, PreparePreapproval, PreapprovalBindingFamily,
  PreapprovalInvocationPath, PreapprovalJson, PreapprovalMemberReview,
  PreapprovalResourcePin, PreapprovalUncoveredCall,
  RecipeDefinition, MailDraft,
} from '@recued/contracts';

export type PreapprovalOrigin = {
  source: ExecutionSource;
  entry: 'owner_ui' | 'kernel';
  credential_id: string | null;
  entry_tool_grants: string[];
  /** Raw MCP operations authorize at the original contract's op gate, not
   * the inbound-token checklist (which cannot contain recued_op_* names). */
  entry_raw_op_id?: string | null;
  recipe_grant_key: string | null;
  /** Exact grant for the future root, separately from the requesting recipe.
   * Selected by the host at preparation and reverified at every continuation. */
  target_recipe_grant_key?: string | null;
  display_name: string;
  credential_label: string | null;
} & (
  | { mode: 'owner'; owner_id: string }
  | { mode: 'contract'; contract_id: string }
);

export interface PreparedInvocation {
  member_id: string;
  invocation_path: PreapprovalInvocationPath;
  op_id: string;
  ingredient_slug: string;
  family: PreapprovalBindingFamily;
  identity_version: number;
  definition_hash: string;
  binding_hash: string;
  /** Private, encrypted dispatch material supplied only by a host resolver.
   * Included in effect identity; never accepted as a recipe/RPC permit. */
  dispatch_snapshot?: PreapprovalJson;
  arguments_hash: string;
  effect_hash: string;
  condition_hash: string;
  parent_member_id: string | null;
  required_child_ids: string[];
  /** Dependency edges, distinct from display order. Independent nested
   * recipe prefetch calls retain their normal parallelism. */
  predecessor_member_ids: string[];
  resources: PreapprovalResourcePin[];
  connection_id: string | null;
  account_id: string | null;
  /** Resolved, immutable, secret-free dispatch input. Vault material is supplied
   * only through the live connection resolver at the actual dispatch seam. */
  input: Record<string, PreapprovalJson>;
  /** DOM/chat output mappings may select writes or clicks. Pin the actual
   * merged mapping even when the normalized input is identical. */
  output: Record<string, string>;
  risk: 'read' | 'write' | 'admin' | 'destructive';
  pre_lift_approval: 'never' | 'ask' | 'always' | null;
  review: PreapprovalMemberReview;
}

export interface PreapprovalTargetBinding {
  kind: 'one_shot' | 'next_schedule' | 'next_auto_run' | 'next_trigger';
  key: string;
  incarnation: string;
  revision: number;
  qualifying_sequence: number;
  due_at: number | null;
  /** The legacy automation's original state, before D-261 parks it. */
  was_enabled: boolean;
}

export interface PreapprovalDependency extends PreapprovalResourcePin {
  /** An independently owned snapshot stops depending on its original source
   * once the owner accepts it. The snapshot's own pin remains terminal. */
  until_phase: 'decision' | 'terminal';
}

export interface PreparedRecipeSnapshot {
  invocation_path: PreapprovalInvocationPath;
  recipe_id: string;
  publisher_id: string;
  /** Hash of the installed definition before dispatch lowering. */
  definition_hash: string;
  /** The actual lowered program and config used by the selected execution. */
  dispatch_hash: string;
  definition: RecipeDefinition;
  effective_config: Record<string, PreapprovalJson>;
}

/** Captured only when an explicitly uncovered local call actually runs.
 * This freezes its continuation; it is never added to the owner's approved
 * inventory and supplies no member, receipt or approval authority. */
export interface OrdinaryRecipeContinuation {
  schema_version: 1;
  snapshot: PreparedRecipeSnapshot;
  requested_config: Record<string, PreapprovalJson>;
  dependencies: PreapprovalDependency[];
}

export interface PreparedFutureExecution {
  schema_version: 1;
  request: PreparePreapproval;
  origin: PreapprovalOrigin;
  target: PreapprovalTargetBinding;
  recipe: { recipe_id: string; publisher_id: string; display_name: string; definition_hash: string };
  recipe_snapshots: PreparedRecipeSnapshot[];
  /** Private saved content, owned by this execution once accepted. */
  draft_snapshot?: MailDraft;
  members: PreparedInvocation[];
  uncovered: PreapprovalUncoveredCall[];
  dependencies: PreapprovalDependency[];
  interaction_notes: string[];
}

/** A qualification poll holds no grant. Its fence only protects continuation
 * of an ordinary watcher hold before the reviewed execution is selected. */
export interface PreapprovalPollBinding {
  poll_id: string; future_execution_ref: string; run_id: string; worker_id: string; fence: number;
}

export interface PreapprovalExecutionBinding {
  future_execution_ref: string;
  root_run_id: string;
  run_id: string;
  worker_id: string;
  fence: number;
}

export interface PreapprovalMemberClaim extends PreapprovalExecutionBinding {
  grant_id: string;
  member_id: string;
  attempt_id: string;
  idempotency_key: string;
  action_ref: string;
  commit_id: string | null;
  parent_attempt_id: string | null;
}

/** Live, server-derived token/principal identity; never an RPC parameter. */
export type PreapprovalResponder =
  | { channel: 'webclient'; key: string }
  | { channel: 'telegram'; key: string; connection_id: string; owner_sender: string };

export type PreapprovalValidationStage = 'prepare' | 'decide' | 'run' | 'member' | 'resume' | 'reconcile';

export interface PreapprovalActivationRecord {
  future_execution_ref: string;
  proposal_id: string;
  grant_id: string;
  accepted_at: number;
  not_before: number;
}
