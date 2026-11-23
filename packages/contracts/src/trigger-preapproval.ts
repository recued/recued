/** D-341 slice B1 — a standing pre-approval on a trigger. A run that a schedule, an event
 *  trigger (a mail fact's among them), a webhook, an armed auto-run (B1b) or a reception form (B4)
 *  starts, with the owner away, may make the writes the owner named, for one recipe version,
 *  within a cap per run, until the owner ends it (ruling 10, 2026-11-08: no end date and no use
 *  cap). A recipe that asks an AI may carry one too: its AI decides the values (ruling 8), and the
 *  page and the ask say so.
 *
 *  B3 — a scheduled prompt carries one too. It runs no recipe: its "recipe" is its prompt, pinned
 *  by the hash of the prompt's text, and its writes are the AI tools' Tier-1 writes, named as
 *  D-329's write rules name them (`triggerPreapprovalTier1Op`).
 *
 *  🔑 WHY IT IS ITS OWN KIND. D-261 approves one reviewed run, whose effects' arguments no event
 *  may supply; D-177's grants match the payload. A webhook body, a mail or a form is different
 *  every time, so both would ask again. This one names the trigger, the recipe version (whose
 *  steps decide the values from the event) and the writes, never the values.
 *
 *  ⛔ WHAT IT NEVER COVERS, whatever a row says: an op held at `approval: 'always'`, a
 *  `destructive` one, or a review an op always gets (any `lift_reason`: a send, a commitment
 *  proposal, a quote, a payment, a quality check) — both gates check all three; a write its recipe's
 *  own steps don't name, a run of another version (for a scheduled prompt, of another prompt
 *  text), a webhook's or a form's run through a door minted since the grant, or a schedule or an
 *  event trigger acting for a contract other than the owner's.
 *
 *  Everything here is pure: no I/O, no clock (callers pass `now`). */

import { executionSourceContractId, type ExecutionSource } from './commits.js';
import { OWNER_CONTRACT_ID } from './contract-definition.js';
import { tier1CallTitle } from './grant-switch-guide.js';
import type { RiskTier } from './ingredient.js';
import { describeWriteRule, isWriteRuleTool, writeRuleScopeOf, type WriteRuleTool } from './write-approval-rule.js';

/** The writes one run may make under it, at most. A grant that names none allows one. */
export const TRIGGER_PREAPPROVAL_MAX_PER_RUN = 100;
/** The ops one pre-approval may name. */
export const TRIGGER_PREAPPROVAL_MAX_WRITES = 20;

export const TRIGGER_PREAPPROVAL_KINDS = ['webhook', 'schedule', 'event_trigger', 'auto_run', 'reception', 'prompt_schedule'] as const;
export type TriggerPreapprovalKind = (typeof TRIGGER_PREAPPROVAL_KINDS)[number];

/** Who a pre-approval names: the trigger itself, by the id the host knows it by. An armed auto-run
 *  by its dish: a timer is one dish's (D-319), as D-261's next-auto-run approval names it. */
export type TriggerPreapprovalTrigger =
  | { readonly kind: 'webhook'; readonly ingress_id: string }
  | { readonly kind: 'schedule'; readonly schedule_id: string }
  | { readonly kind: 'event_trigger'; readonly trigger_id: string }
  | { readonly kind: 'auto_run'; readonly dish_id: string }
  /** B4 — a reception form (or a booking link), by its endpoint: what its submissions run as. */
  | { readonly kind: 'reception'; readonly endpoint_id: string }
  /** B3 — a scheduled prompt, by its schedule (a prompt's schedule is the prompt: one id). */
  | { readonly kind: 'prompt_schedule'; readonly schedule_id: string };

/** The field each kind names its trigger by. */
export const TRIGGER_PREAPPROVAL_REF_FIELD = {
  webhook: 'ingress_id',
  schedule: 'schedule_id',
  event_trigger: 'trigger_id',
  auto_run: 'dish_id',
  reception: 'endpoint_id',
  prompt_schedule: 'schedule_id',
} as const satisfies Readonly<Record<TriggerPreapprovalKind, string>>;

/** The kinds whose runs go through a door contract, which their pre-approval pins: a door
 *  minted again (the recipe's capabilities changed) ends it. */
export const triggerPreapprovalHasDoor = (kind: TriggerPreapprovalKind): boolean =>
  kind === 'webhook' || kind === 'reception';

// ── D-402 slice F2 — what starts a run, beside a trigger: the owner's chats, or an AI app ────────

/** D-402 §7.6 — a pre-approval may name the caller that starts a run instead of a trigger: the owner's
 *  chats (one fixed reference, as D-329 keys `owner_chat`), or an AI app (its contract). Found by the
 *  run's caller and recipe version (`preapprovalCallerOf`), never through `triggeredRunOf`: adding
 *  these callers there would change every held step's ask in a chat or an AI app's run. Granted from
 *  the question before a run (§7.4), never from a trigger's page. Kept in the same table, matched at
 *  the same two gates, with the same exclusions, ending and audit as a trigger's. */
export const PREAPPROVAL_CALLER_KINDS = ['owner_chat', 'ai_app'] as const;
export type PreapprovalCallerKind = (typeof PREAPPROVAL_CALLER_KINDS)[number];

/** The one reference every row for the owner's chats carries. */
export const PREAPPROVAL_OWNER_CHAT_REF = 'owner';

export type PreapprovalCaller =
  | { readonly kind: 'owner_chat' }
  | { readonly kind: 'ai_app'; readonly contract_id: string };

/** The caller a run's own source names, as D-329 names it (`writeRulePrincipalOf`): the owner's chat
 *  (in the app or a messenger, under no contract) or an AI app (its contract). None for any other
 *  source. */
export const preapprovalCallerOf = (source: ExecutionSource | undefined): PreapprovalCaller | undefined => {
  if (source === undefined) return undefined;
  if (source.channel === 'mcp') return isId(source.contract_id) ? { kind: 'ai_app', contract_id: source.contract_id } : undefined;
  if ((source.channel === 'chat' || source.channel === 'messenger') && source.actor === 'user_self'
    && executionSourceContractId(source) === undefined) return { kind: 'owner_chat' };
  return undefined;
};

/** A persisted caller read back (a checkpoint's, an ask's), or undefined. */
export const readPreapprovalCaller = (value: unknown): PreapprovalCaller | undefined => {
  if (!record(value)) return undefined;
  if (value.kind === 'owner_chat') return { kind: 'owner_chat' };
  return value.kind === 'ai_app' && isId(value.contract_id) ? { kind: 'ai_app', contract_id: value.contract_id } : undefined;
};

/** The reference a caller's rows carry: the fixed one for the owner's chats, an AI app's contract id. */
export const preapprovalCallerRef = (caller: PreapprovalCaller): string =>
  caller.kind === 'owner_chat' ? PREAPPROVAL_OWNER_CHAT_REF : caller.contract_id;

export const samePreapprovalCaller = (a: PreapprovalCaller, b: PreapprovalCaller): boolean =>
  a.kind === b.kind && preapprovalCallerRef(a) === preapprovalCallerRef(b);

/** D-402 slice H4 (§7.6, §8 item 7) — the browsers a run's settings name, by setting
 *  (`browser_1` → a browser's lasting id), for a recipe that names its browsers. A caller's pre-approval
 *  records the ones it was granted for: each site's writes run in the browser its setting named then, so
 *  a browser setting changed under "Always" is not covered, and the run asks again. */
export type PreapprovalBrowsers = Readonly<Record<string, string>>;

/** Two runs' browsers are the same when each setting names the same browser. None and an empty record
 *  are the same: a recipe that names no browser is covered as before. */
export const samePreapprovalBrowsers = (a: PreapprovalBrowsers | undefined, b: PreapprovalBrowsers | undefined): boolean => {
  const left = Object.entries(a ?? {});
  const right = b ?? {};
  return left.length === Object.keys(right).length
    && left.every(([key, id]) => Object.prototype.hasOwnProperty.call(right, key) && right[key] === id);
};

/** A stored record of browsers read back, or undefined when it is not one. */
export const readPreapprovalBrowsers = (value: unknown): PreapprovalBrowsers | undefined => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 64 || !entries.every(([key, id]) => key.length > 0 && key.length <= 128
    && typeof id === 'string' && id.length > 0 && id.length <= 256)) return undefined;
  return Object.fromEntries(entries) as Record<string, string>;
};

/** D-402 ruling 17 — the recipes a run starts through a pack's binding (D-232's local recipe op), each at
 *  the version the question before the run saw: recipe id → its sha256. A caller's pre-approval granted
 *  with them covers those recipes' writes too, at those versions alone. */
export type PreapprovalNested = Readonly<Record<string, string>>;

/** Two records of nested recipes are the same when each names the same recipes at the same versions. None
 *  and an empty record are the same. */
export const samePreapprovalNested = (a: PreapprovalNested | undefined, b: PreapprovalNested | undefined): boolean => {
  const left = Object.entries(a ?? {});
  const right = b ?? {};
  return left.length === Object.keys(right).length
    && left.every(([id, sha]) => Object.prototype.hasOwnProperty.call(right, id) && right[id] === sha);
};

/** A stored record of nested recipes read back, or undefined when it is not one. */
export const readPreapprovalNested = (value: unknown): PreapprovalNested | undefined => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 64 || !entries.every(([id, sha]) => id.length > 0 && id.length <= 200
    && typeof sha === 'string' && /^[0-9a-f]{64}$/u.test(sha))) return undefined;
  return Object.fromEntries(entries) as Record<string, string>;
};

/** Ruling 5 — a pre-approval granted from now on covers the whole recipe: every write its version's
 *  own steps make, with no count. Recorded so a reader that predates it never takes it for a cap of
 *  once a run: its writes are this one name, which no op is, and its cap per run is 0, which a run
 *  has always spent. Rows granted before stay as granted (ruling 9). */
export const TRIGGER_PREAPPROVAL_ALL_WRITES = '*';
export const TRIGGER_PREAPPROVAL_WHOLE_RECIPE = 0;

/** Whether a row covers its recipe's every write, with no count (ruling 5). */
export const coversWholeRecipe = (row: Pick<TriggerPreapprovalRow, 'writes' | 'max_per_run'>): boolean =>
  row.max_per_run === TRIGGER_PREAPPROVAL_WHOLE_RECIPE && row.writes.length === 1 && row.writes[0] === TRIGGER_PREAPPROVAL_ALL_WRITES;

export interface TriggerPreapprovalRow {
  readonly id: string;
  readonly trigger: TriggerPreapprovalTrigger;
  /** What the trigger runs: a recipe, or for a scheduled prompt (B3) the prompt, by its schedule's
   *  id. */
  readonly recipe_id: string;
  /** The version it was granted for: the sha256 of the recipe's canonical definition, as a run
   *  computes it; for a scheduled prompt, of its prompt's text, as the scheduler stamps it
   *  (`ScheduledPromptOrigin.prompt_sha256`). A run of any other version is not covered. */
  readonly recipe_sha256: string;
  /** A webhook's or a reception form's: the door its runs of the recipe went through when it was
   *  granted. A door minted again (the recipe's capabilities changed) ends it. */
  readonly door_contract_id?: string;
  /** B6 (ruling 12) — a recipe a scheduled prompt starts: the version of the prompt's text, which it
   *  is pinned to as well as the recipe's (`recipe_sha256`). An edit to either ends it. Absent on
   *  every other row, a scheduled prompt's own writes (B3, B5) among them. */
  readonly prompt_sha256?: string;
  /** The writes it allows: the ops the recipe's own steps call, each named as the gate resolves it
   *  (D-211's identity: a catalog op by its qualified `operation_id`, a single-op ingredient by its
   *  slug). */
  readonly writes: readonly string[];
  readonly max_per_run: number;
  /** How many writes it has let through, all runs together. Counted, never a cap (ruling 10). */
  readonly uses: number;
  readonly created_at: number;
  readonly revoked_at?: number;
  readonly last_used_at?: number;
}

/** D-402 slice F2 — a pre-approval a caller holds (§7.6): the owner's chats or an AI app, for one recipe
 *  version, covering the whole recipe (ruling 5). "Always, for this recipe" names no run; "Yes, this
 *  time" names its run, which alone uses it, and which a later "Always" never reuses. */
export interface CallerPreapprovalRow {
  readonly id: string;
  readonly caller: PreapprovalCaller;
  readonly recipe_id: string;
  readonly recipe_sha256: string;
  /** "Yes, this time": the one run it covers. */
  readonly run_id?: string;
  /** D-402 slice H4 — for a recipe that names its browsers, the browser each of its settings named when
   *  it was granted: a run whose settings name another is not covered. */
  readonly browsers?: PreapprovalBrowsers;
  /** D-402 ruling 17 — the recipes the run starts, at the versions the question saw: their writes are
   *  covered too. */
  readonly nested?: PreapprovalNested;
  readonly uses: number;
  readonly created_at: number;
  readonly revoked_at?: number;
  readonly last_used_at?: number;
}

/** D-402 slice F4 (§7.9) — a caller's pre-approval as the owner's pages list it. `outdated`: the recipe
 *  changed since, or is gone; a one-run row whose run is over reads `revoked` once its run ends it. */
export type CallerPreapprovalState = 'live' | 'revoked' | 'outdated';
export interface CallerPreapprovalView extends CallerPreapprovalRow {
  readonly state: CallerPreapprovalState;
  /** The recipe's own name, or its id once it is gone. */
  readonly recipe_name: string;
  /** Who holds it, in the owner's words: "your chats", or the AI app by the name its key has. */
  readonly caller_name: string;
}

/** D-402 slice F4 (ruling 12) — what one "Stop allowing" ended, by kind: the caller's pre-approvals
 *  for the recipe (every version, a one-run row), its site passes, its session grants ("Allow in this
 *  chat"), its delegation rules and quality delegations, and its write rules naming the recipe. */
export interface StopAllowingResult {
  readonly preapprovals: number;
  readonly site_passes: number;
  readonly session_grants: number;
  readonly delegations: number;
  readonly write_rules: number;
}

/** D-402 slice F5 (§7.10) — what let a write of a run through without asking the owner:
 *  - `always`: the "Always, for this recipe" the owner gave the run's caller (F3);
 *  - `this_run`: the owner's "Yes, this time" for this run, before it started (F3);
 *  - `site_pass`: a site pass for the recipe's browser writes (D-335 slice F);
 *  - `grant`: "Allow in this chat", a session or batch grant, or a delegation (D-177, D-202);
 *  - `rule`: a chain rule the owner accepted (D-348);
 *  - `trigger`: a trigger's or a scheduled prompt's pre-approval (D-341 B);
 *  - `switch`: the chat's "Don't ask about browser actions" (D-341 slice A). */
export type RunLetThroughBy = 'always' | 'this_run' | 'site_pass' | 'grant' | 'rule' | 'trigger' | 'switch';
export const RUN_LET_THROUGH_ORDER: ReadonlyArray<RunLetThroughBy> = ['always', 'this_run', 'site_pass', 'grant', 'rule', 'trigger', 'switch'];
/** The kinds a "Stop allowing" ends (ruling 12): what stands beyond this run, for its caller and recipe. */
export const RUN_LET_THROUGH_STOPPABLE: ReadonlySet<RunLetThroughBy> = new Set(['always', 'site_pass', 'grant', 'rule']);

/** D-402 slice F5 (§7.10) — which of a run's writes ran without asking, and what let them: on the run's
 *  response, for the owner's run page and, in words, for the model. A browser batch is one write. */
export interface RunLetThrough {
  /** Who ran it, when "Stop allowing" can end what let it: the owner's chats, or an AI app. */
  readonly caller?: PreapprovalCaller;
  readonly writes: ReadonlyArray<{ readonly by: RunLetThroughBy; readonly count: number }>;
}

/** What one "Stop allowing" ended, in the owner's words ("1 standing approval and 2 site passes"), or
 *  `''` when it ended nothing. Said by the owner's chat (`recipe.stop_allowing`) and the app's pages. */
export const stopAllowingSummary = (ended: StopAllowingResult): string => {
  const counted: ReadonlyArray<readonly [number, string, string]> = [
    [ended.preapprovals, 'standing approval', 'standing approvals'], [ended.site_passes, 'site pass', 'site passes'],
    [ended.session_grants, '"Allow in this chat"', '"Allow in this chat"'], [ended.delegations, 'delegation', 'delegations'],
    [ended.write_rules, 'rule', 'rules'],
  ];
  const parts = counted.filter(([count]) => count > 0).map(([count, one, many]) => `${String(count)} ${count === 1 ? one : many}`);
  return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]!}`;
};

/** Whether a caller's row stands in for this write: not ended, the same caller and recipe version, and
 *  for a one-run row, this run. Every write of the version is the row's (ruling 5); which call is the
 *  version's own write, and which ones no pre-approval ever covers, are the gates' and the host's. */
export const callerPreapprovalCovers = (
  row: CallerPreapprovalRow,
  call: { readonly caller: PreapprovalCaller; readonly recipe_id: string; readonly recipe_sha256: string; readonly run_id: string;
    /** D-402 slice H4 — the browsers the run's settings name. */
    readonly browsers?: PreapprovalBrowsers;
    /** D-402 ruling 17 — a write of a recipe this run started (`recipe_id` is then the outer run's): the
     *  row must name it at this version. */
    readonly nested?: { readonly recipe_id: string; readonly recipe_sha256: string } },
): boolean => row.revoked_at === undefined
  && samePreapprovalCaller(row.caller, call.caller)
  && row.recipe_id === call.recipe_id
  && row.recipe_sha256 === call.recipe_sha256
  && (row.run_id === undefined || row.run_id === call.run_id)
  && samePreapprovalBrowsers(row.browsers, call.browsers)
  && (call.nested === undefined || row.nested?.[call.nested.recipe_id] === call.nested.recipe_sha256);

/** Why a row covers nothing now, or `live`. It has no end of its own (ruling 10): `revoked` is the
 *  owner ending it. `outdated`: the recipe changed since the grant, or is gone. `detached`: its
 *  trigger no longer starts the recipe, or a webhook's door was minted again. */
export type TriggerPreapprovalState = 'live' | 'revoked' | 'outdated' | 'detached';

export interface TriggerPreapprovalView extends TriggerPreapprovalRow {
  readonly state: TriggerPreapprovalState;
  /** The recipe's own name, or its id once it is gone. */
  readonly recipe_name: string;
  /** D-341 slice B2 — each write in the owner's words, in `writes`' order: what its operation says
   *  it does, else its op id. */
  readonly write_labels: readonly string[];
  /** The recipe's steps that ask an AI (ruling 8): its AI decides what these writes carry. Empty
   *  for a recipe without one, or one that is gone. */
  readonly ai_steps: readonly string[];
  /** The owner's words for it. */
  readonly description: string;
}

/** What the owner asks for. The server pins the recipe's installed version itself. It lasts until
 *  the owner ends it: a grant names no end date and no use cap (ruling 10). */
export interface TriggerPreapprovalGrantRequest {
  readonly trigger: TriggerPreapprovalTrigger;
  readonly recipe_id: string;
  readonly writes: readonly string[];
  readonly max_per_run?: number;
}

export interface NormalizedTriggerPreapprovalGrant {
  readonly trigger: TriggerPreapprovalTrigger;
  readonly recipe_id: string;
  readonly writes: readonly string[];
  readonly max_per_run: number;
}

// A reception endpoint's id is base64url, so it may start with `-` or `_` (B4).
const ID = /^[A-Za-z0-9_-][A-Za-z0-9._:/@-]{0,255}$/u;
const isId = (value: unknown): value is string => typeof value === 'string' && ID.test(value);

/** What a gate asks the host about a held write, in its ask branch: the commit gateway for a
 *  single-op ingredient, the engine's catalog gate for a catalog op (with the op it resolved). The
 *  host names the trigger, the recipe version and the step's own op from the run; it counts a use
 *  when it admits, and returns the pre-approval's id. `null` or a throw leaves the ask standing. */
export interface TriggerPreapprovalAdmission {
  readonly slug: string;
  /** A catalog op's qualified id, as the catalog gate resolved it. Absent at the commit gateway. */
  readonly operation_id?: string;
  /** The engine's step id: which of the recipe's own steps this call is. */
  readonly step_id?: string;
  readonly risk_tier: RiskTier;
}

export interface TriggerPreapprovalHooks {
  admit: (call: TriggerPreapprovalAdmission) => string | null;
}

/** A run a trigger started, as the run's own source names it. */
export interface TriggeredRun {
  readonly trigger: TriggerPreapprovalTrigger;
  /** A webhook's or a form's run's door: the contract its recipe runs through. */
  readonly door_contract_id?: string;
  /** B6 — a recipe a scheduled prompt started: the version of the prompt's text that started it. */
  readonly prompt_sha256?: string;
}

/** The trigger a run's own source names, or none. Read off the host's authenticated source, never
 *  off anything the event carried: a webhook's ingress and door, a reception form's endpoint and
 *  door (B4), a schedule's id, an event trigger's id, an armed auto-run's dish (its tick's
 *  `auto_run_tick`, B1b). A schedule, an event
 *  trigger or an auto-run acting for a contract other than the owner's names none: it runs for that
 *  contract, not as the owner's own automation. A scheduled prompt names none here: its own writes
 *  are its chat's, matched at the chat's gate (`scheduledPromptRunOf`, B3), and a recipe its chat
 *  starts is that recipe's run. */
export const triggeredRunOf = (source: ExecutionSource | undefined): TriggeredRun | undefined => {
  if (source === undefined) return undefined;
  if (source.channel === 'webhook') {
    if (source.actor !== 'anonymous' || !isId(source.webhook_secret_id)) return undefined;
    return {
      trigger: { kind: 'webhook', ingress_id: source.webhook_secret_id },
      ...(isId(source.contract_id) ? { door_contract_id: source.contract_id } : {}),
    };
  }
  // B4 — a submission to a reception form, through the form's door (the source's `contract_id`).
  if (source.channel === 'reception') {
    if (source.actor !== 'anonymous' || !isId(source.reception_id)) return undefined;
    return {
      trigger: { kind: 'reception', endpoint_id: source.reception_id },
      ...(isId(source.contract_id) ? { door_contract_id: source.contract_id } : {}),
    };
  }
  const contract = executionSourceContractId(source);
  const owners = contract === undefined || contract === OWNER_CONTRACT_ID;
  if (source.channel === 'schedule') {
    return source.actor === 'system' && owners && source.prompt_schedule === undefined && isId(source.schedule_id)
      ? { trigger: { kind: 'schedule', schedule_id: source.schedule_id } }
      : undefined;
  }
  if (source.channel === 'reactive') {
    if (source.actor !== 'system' || !owners) return undefined;
    if (isId(source.trigger_id)) return { trigger: { kind: 'event_trigger', trigger_id: source.trigger_id } };
    // Only a timer's own tick: a dish another reactive run carried names no auto-run.
    return source.event_kind === 'auto_run_tick' && isId(source.dish_id)
      ? { trigger: { kind: 'auto_run', dish_id: source.dish_id } }
      : undefined;
  }
  return undefined;
};

/** The id a trigger is known by in its own store. */
export const triggerRefOf = (trigger: TriggerPreapprovalTrigger): string =>
  (trigger as unknown as Record<string, string>)[TRIGGER_PREAPPROVAL_REF_FIELD[trigger.kind]]!;

export const triggerFromRef = (kind: TriggerPreapprovalKind, ref: string): TriggerPreapprovalTrigger =>
  ({ kind, [TRIGGER_PREAPPROVAL_REF_FIELD[kind]]: ref }) as unknown as TriggerPreapprovalTrigger;

export const sameTrigger = (a: TriggerPreapprovalTrigger, b: TriggerPreapprovalTrigger): boolean =>
  a.kind === b.kind && triggerRefOf(a) === triggerRefOf(b);

/** What a row is, for a recipe whose installed version has this hash (or none installed). Its trigger
 *  starting the recipe is the server's to check (`detached`). */
export const triggerPreapprovalState = (
  row: TriggerPreapprovalRow,
  installed_sha256?: string,
): TriggerPreapprovalState => {
  if (row.revoked_at !== undefined) return 'revoked';
  if (installed_sha256 !== undefined && installed_sha256 !== row.recipe_sha256) return 'outdated';
  return 'live';
};

/** Whether a row stands in for this write: not ended, the same trigger (for a webhook or a form,
 *  through the same door) and recipe version, and naming the op. The cap per run is the store's to count, as
 *  it keeps the runs. */
export const triggerPreapprovalCovers = (
  row: TriggerPreapprovalRow,
  call: TriggeredRun & {
    readonly recipe_id: string;
    readonly recipe_sha256: string;
    readonly op: string;
  },
): boolean => triggerPreapprovalState(row) === 'live'
  && sameTrigger(row.trigger, call.trigger)
  && (!triggerPreapprovalHasDoor(row.trigger.kind)
    || (row.door_contract_id !== undefined && row.door_contract_id === call.door_contract_id))
  && row.recipe_id === call.recipe_id
  && row.recipe_sha256 === call.recipe_sha256
  // B6 — a recipe a scheduled prompt starts: that prompt's version too, and only such a row covers it.
  && row.prompt_sha256 === call.prompt_sha256
  // Ruling 5 — a row granted from now on names every write of the version.
  && (coversWholeRecipe(row) || row.writes.includes(call.op));

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const bound = (value: unknown, field: string, max: number, fallback: number): number => {
  if (value === undefined) return Math.min(fallback, max);
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a whole number of at least 1`);
  if (value > max) throw new Error(`${field} can be at most ${String(max)}`);
  return value;
};

/** A trigger as a request names it, or undefined: one of the kinds, with its own id. */
export const readTriggerPreapprovalTrigger = (value: unknown): TriggerPreapprovalTrigger | undefined => {
  if (!record(value) || !(TRIGGER_PREAPPROVAL_KINDS as readonly unknown[]).includes(value.kind)) return undefined;
  const kind = value.kind as TriggerPreapprovalKind;
  const ref = value[TRIGGER_PREAPPROVAL_REF_FIELD[kind]];
  return isId(ref) ? triggerFromRef(kind, ref) : undefined;
};

/** A grant request, checked, with its bounds filled in. Throws the words the rpc reports. Whether
 *  the recipe is installed, the writes are its steps' own and the trigger runs it are the server's
 *  to check: this sees only the shape. */
export const normalizeTriggerPreapprovalGrant = (input: unknown): NormalizedTriggerPreapprovalGrant => {
  if (!record(input)) throw new Error('the request must be an object');
  const trigger = input.trigger;
  if (!record(trigger) || !(TRIGGER_PREAPPROVAL_KINDS as readonly unknown[]).includes(trigger.kind)) {
    throw new Error(`trigger.kind must be one of ${TRIGGER_PREAPPROVAL_KINDS.join(', ')}`);
  }
  const kind = trigger.kind as TriggerPreapprovalKind;
  const refField = TRIGGER_PREAPPROVAL_REF_FIELD[kind];
  if (!isId(trigger[refField])) throw new Error(`trigger.${refField} is required`);
  if (!isId(input.recipe_id)) throw new Error('recipe_id is required');
  // D-402 ruling 5 — every write of the recipe's version, with no count: what a page grants from now on.
  if (Array.isArray(input.writes) && input.writes.length === 1 && input.writes[0] === TRIGGER_PREAPPROVAL_ALL_WRITES) {
    if (input.max_per_run !== undefined) throw new Error('a pre-approval of every write has no cap a run');
    if (input.max_uses !== undefined || input.ttl_ms !== undefined) {
      throw new Error('a pre-approval has no use cap or end date: it lasts until you end it');
    }
    return {
      trigger: triggerFromRef(kind, trigger[refField] as string),
      recipe_id: input.recipe_id,
      writes: [TRIGGER_PREAPPROVAL_ALL_WRITES],
      max_per_run: TRIGGER_PREAPPROVAL_WHOLE_RECIPE,
    };
  }
  if (!Array.isArray(input.writes) || input.writes.length === 0) throw new Error('writes must name at least one op');
  if (input.writes.length > TRIGGER_PREAPPROVAL_MAX_WRITES) throw new Error(`writes can name at most ${String(TRIGGER_PREAPPROVAL_MAX_WRITES)} ops`);
  if (!input.writes.every(isId)) throw new Error('each write must be an op id');
  // Refused, not ignored: a caller asking for a limit must not believe it got one.
  if (input.max_uses !== undefined || input.ttl_ms !== undefined) {
    throw new Error('a pre-approval has no use cap or end date: it lasts until you end it');
  }
  return {
    trigger: triggerFromRef(kind, trigger[refField] as string),
    recipe_id: input.recipe_id,
    writes: [...new Set(input.writes as string[])],
    max_per_run: bound(input.max_per_run, 'max_per_run', TRIGGER_PREAPPROVAL_MAX_PER_RUN, 1),
  };
};

/** The trigger in the owner's words, as a pre-approval names it: "its webhook". */
export const TRIGGER_PREAPPROVAL_TRIGGER_WORDS: Readonly<Record<TriggerPreapprovalKind, string>> = {
  webhook: 'its webhook',
  schedule: 'its schedule',
  event_trigger: 'its trigger',
  auto_run: 'its auto-run',
  reception: 'its form',
  prompt_schedule: 'its schedule',
};
const TRIGGER_WORDS = TRIGGER_PREAPPROVAL_TRIGGER_WORDS;

/** The trigger as the owner's pages name it: "webhook", "auto-run". */
export const TRIGGER_PREAPPROVAL_TRIGGER_NOUNS: Readonly<Record<TriggerPreapprovalKind, string>> = {
  webhook: 'webhook',
  schedule: 'schedule',
  event_trigger: 'trigger',
  auto_run: 'auto-run',
  reception: 'form',
  prompt_schedule: 'scheduled prompt',
};

/** How the trigger starts its recipe, in the owner's words: "when its webhook runs it"; for an
 *  armed auto-run, which nothing outside starts, "when it runs on its own"; for a scheduled prompt,
 *  which is its own recipe, "when it runs on its schedule". */
export const triggerPreapprovalWhen = (kind: TriggerPreapprovalKind, recipe: string): string =>
  kind === 'auto_run' ? `when ${recipe} runs on its own`
    : kind === 'prompt_schedule' ? `when ${recipe} runs on its schedule`
      : `when ${TRIGGER_WORDS[kind]} runs ${recipe}`;

/** A label set mid-sentence: a sentence's capital lowered, an op id left as it is. */
const midSentence = (label: string): string => (/^[A-Z][a-z]/u.test(label) ? `${label[0]!.toLowerCase()}${label.slice(1)}` : label);

/** "Once a run", "Up to 3 times a run"; for a row with no count (ruling 5), "Every time it runs". */
export const triggerPreapprovalPerRun = (max_per_run: number): string =>
  max_per_run === TRIGGER_PREAPPROVAL_WHOLE_RECIPE ? 'Every time it runs'
    : max_per_run === 1 ? 'Once a run' : `Up to ${String(max_per_run)} times a run`;

/** Its terms, where the owner sees one: "Once a run · used 4 times · until you end it". */
export const triggerPreapprovalTerms = (row: Pick<TriggerPreapprovalRow, 'max_per_run' | 'uses'>): string =>
  `${triggerPreapprovalPerRun(row.max_per_run)} · `
    + `${row.uses === 0 ? 'not used yet' : row.uses === 1 ? 'used once' : `used ${String(row.uses)} times`} · until you end it`;

/** What the owner is told about a recipe that asks an AI, beside its pre-approvals (ruling 8). */
export const TRIGGER_PREAPPROVAL_AI_NOTE = 'Its AI decides what it writes.';

/** …and about one whose writes are its browser actions (B5), which it does rather than writes. */
export const triggerPreapprovalAiNote = (writes: readonly string[]): string =>
  writes.length > 0 && writes.every((op) => op === TRIGGER_PREAPPROVAL_BROWSER_OP)
    ? 'Its AI decides what it does.' : TRIGGER_PREAPPROVAL_AI_NOTE;

/** The owner's words: "Receive Apple Health readings, when its webhook runs it, may do this without
 *  asking: save up to 100 daily readings in one transaction, all or none. Once a run, until you end
 *  it." With `ai_steps`, it says its AI decides what they write. `labels` name the writes
 *  (`write_labels`); their op ids when absent. */
export const describeTriggerPreapproval = (
  row: Pick<TriggerPreapprovalRow, 'trigger' | 'writes' | 'max_per_run'>,
  recipe_name: string,
  labels: readonly string[] = row.writes,
  ai_steps: readonly string[] = [],
): string =>
  `${recipe_name}, ${triggerPreapprovalWhen(row.trigger.kind, 'it')}, may do ${labels.length === 1 ? 'this' : 'these'} `
    + `without asking: ${labels.map(midSentence).join('; ')}. `
    + `${ai_steps.length > 0 ? `${triggerPreapprovalAiNote(row.writes)} ` : ''}`
    + `${triggerPreapprovalPerRun(row.max_per_run)}, until you end it.`;

/** B6 — a recipe a scheduled prompt starts, in the owner's words: "Save readings, when your scheduled
 *  prompt Morning bills runs it, may do this without asking: …". Its AI decides what it writes: the
 *  prompt's AI starts it and gives it its settings. */
export const describePromptRecipePreapproval = (
  row: Pick<TriggerPreapprovalRow, 'writes' | 'max_per_run'>,
  recipe_name: string,
  prompt_title: string,
  labels: readonly string[] = row.writes,
): string =>
  `${recipe_name}, when your scheduled prompt ${prompt_title} runs it, may do ${labels.length === 1 ? 'this' : 'these'} `
    + `without asking: ${labels.map(midSentence).join('; ')}. ${TRIGGER_PREAPPROVAL_AI_NOTE} `
    + `${triggerPreapprovalPerRun(row.max_per_run)}, until you end it.`;

// ── D-341 slice B2 — granted from an ask ───────────────────────────────────────────────────────

/** What a held write's "Always allow for this <trigger>" would grant, as the hold read it: the
 *  run's trigger (a webhook's door too), the recipe version and the op its step calls. Kept on the
 *  checkpoint (`preflight_context.trigger_preapproval`), so a re-raised ask offers it too. The
 *  answer grants exactly this, after checking again that it is what is installed. */
export interface TriggerPreapprovalOffer {
  readonly trigger: TriggerPreapprovalTrigger;
  readonly door_contract_id?: string;
  readonly recipe_id: string;
  readonly recipe_sha256: string;
  /** The op, as the gate names it. */
  readonly op: string;
  /** Set when the recipe asks an AI (ruling 8): the ask says its AI decides what it writes. */
  readonly asks_ai?: true;
  /** B6 — a recipe a scheduled prompt started: the version of the prompt's text that started it. */
  readonly prompt_sha256?: string;
}

/** A persisted offer read back (it round-trips through the checkpoint's JSON), or undefined: an
 *  offer this version cannot read offers nothing. */
export const readTriggerPreapprovalOffer = (value: unknown): TriggerPreapprovalOffer | undefined => {
  if (!record(value)) return undefined;
  const trigger = value.trigger;
  if (!record(trigger) || !(TRIGGER_PREAPPROVAL_KINDS as readonly unknown[]).includes(trigger.kind)) return undefined;
  const kind = trigger.kind as TriggerPreapprovalKind;
  const ref = trigger[TRIGGER_PREAPPROVAL_REF_FIELD[kind]];
  if (!isId(ref) || !isId(value.recipe_id) || !isId(value.op)
    || typeof value.recipe_sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(value.recipe_sha256)) return undefined;
  // A webhook's or a form's grant pins its door: one without it would never cover a run.
  if (triggerPreapprovalHasDoor(kind) && !isId(value.door_contract_id)) return undefined;
  return {
    trigger: triggerFromRef(kind, ref),
    ...(triggerPreapprovalHasDoor(kind) ? { door_contract_id: value.door_contract_id as string } : {}),
    recipe_id: value.recipe_id,
    recipe_sha256: value.recipe_sha256,
    op: value.op,
    ...(value.asks_ai === true ? { asks_ai: true as const } : {}),
    // B6 — a recipe a scheduled prompt started; any other kind never carries one.
    ...(kind === 'prompt_schedule' && typeof value.prompt_sha256 === 'string' && /^[0-9a-f]{64}$/u.test(value.prompt_sha256)
      ? { prompt_sha256: value.prompt_sha256 } : {}),
  };
};

/** The answer on a held write a trigger's run made, beside allow once and deny. ⚠ Ids stay within
 *  23 bytes: Telegram carries `ask-<uuid>|<option>` in a 64-byte callback. */
export const TRIGGER_PREAPPROVAL_OPTION_ID = 'allow_trigger';

const TRIGGER_NOUNS = TRIGGER_PREAPPROVAL_TRIGGER_NOUNS;

export const triggerPreapprovalOption = (kind: TriggerPreapprovalKind): { id: typeof TRIGGER_PREAPPROVAL_OPTION_ID; label: string } =>
  ({ id: TRIGGER_PREAPPROVAL_OPTION_ID, label: `Always allow for this ${TRIGGER_NOUNS[kind]}` });

/** The option an offer is answered with: a scheduled prompt's browser actions (B5) are all of them,
 *  not this one write, so its label says so. */
export const triggerPreapprovalOfferOption = (
  offer: Pick<TriggerPreapprovalOffer, 'trigger' | 'op'>,
): { id: typeof TRIGGER_PREAPPROVAL_OPTION_ID; label: string } =>
  offer.op === TRIGGER_PREAPPROVAL_BROWSER_OP
    ? { id: TRIGGER_PREAPPROVAL_OPTION_ID, label: `Always allow browser actions for this ${TRIGGER_NOUNS[offer.trigger.kind]}` }
    : triggerPreapprovalOption(offer.trigger.kind);

/** The bounds an ask's answer grants: a grant that names none, once a run, until the owner ends
 *  it. The trigger's page can allow more a run. */
export const TRIGGER_PREAPPROVAL_ASK_GRANT = { max_per_run: 1 } as const;

/** What the answer lets happen, said before the question: its own paragraph, like the site
 *  answers' (`renderBrowserPassBlock`). It says where to end it: there is no end date. */
export const describeTriggerPreapprovalOffer = (offer: TriggerPreapprovalOffer, recipe_name: string): string =>
  // B6 — a recipe a scheduled prompt starts: named, since the prompt is what runs on its schedule.
  offer.prompt_sha256 !== undefined
    ? `“${triggerPreapprovalOfferOption(offer).label}” stops asking about this write when it runs ${recipe_name} on its `
      + 'schedule, once a run, until you end it on the scheduled prompt\'s page or under Contracts. Its AI decides what it '
      + 'writes. A change to its prompt or to the recipe asks you again.'
  : offer.op === TRIGGER_PREAPPROVAL_BROWSER_OP
    ? `“${triggerPreapprovalOfferOption(offer).label}” stops asking about its browser actions, on any site, `
      + `${triggerPreapprovalWhen(offer.trigger.kind, recipe_name)}, up to `
      + `${String(TRIGGER_PREAPPROVAL_BROWSER_PER_RUN)} a run, until you end it on the `
      + `${TRIGGER_NOUNS[offer.trigger.kind]}'s page or under Contracts. Sites you blocked, putting your files into `
      + 'a page and sign-in codes still ask. Its AI decides what it does. A change to its prompt asks you again.'
    : offer.trigger.kind === 'prompt_schedule'
      ? `“Always allow for this ${TRIGGER_NOUNS[offer.trigger.kind]}” stops asking about this write `
        + `${triggerPreapprovalWhen(offer.trigger.kind, recipe_name)}, once a run, until you end it on the `
        + `${TRIGGER_NOUNS[offer.trigger.kind]}'s page or under Contracts.`
        + `${offer.asks_ai === true ? ` ${TRIGGER_PREAPPROVAL_AI_NOTE}` : ''} A change to its prompt asks you again.`
      // D-402 ruling 10 — a trigger's "Always allow" covers every write of the recipe's version.
      : `“Always allow for this ${TRIGGER_NOUNS[offer.trigger.kind]}” stops asking about what ${recipe_name} writes `
        + `${triggerPreapprovalWhen(offer.trigger.kind, 'it')}, until you end it on the `
        + `${TRIGGER_NOUNS[offer.trigger.kind]}'s page or under Contracts. Deleting, anything that needs your review `
        + 'and anything set to ask every time still ask.'
        + `${offer.asks_ai === true ? ` ${TRIGGER_PREAPPROVAL_AI_NOTE}` : ''} A change to the recipe asks you again.`;

// ── D-341 slice B2b — granted on the trigger's page ────────────────────────────────────────────

/** A write a recipe's steps make, as the trigger's page offers it. */
export interface TriggerPreapprovalChoiceWrite {
  /** The op, as the gate names it. */
  readonly op: string;
  /** The owner's words for it. */
  readonly label: string;
  /** Whether a pre-approval may name it. A destructive op and one the owner's policy always asks
   *  about never are: the gates would ask anyway. */
  readonly offerable: boolean;
  /** Why not, in the owner's words, when it is not. */
  readonly reason?: string;
}

/** One recipe a trigger starts, with what its page may grant for it. */
export interface TriggerPreapprovalChoice {
  readonly recipe_id: string;
  readonly recipe_name: string;
  /** The steps that ask an AI: its AI decides what these writes carry (ruling 8). The page says so. */
  readonly ai_steps: readonly string[];
  /** The writes its steps make. Reads are not listed: they never ask. */
  readonly writes: readonly TriggerPreapprovalChoiceWrite[];
  /** This trigger's pre-approvals for this recipe, newest first. */
  readonly preapprovals: readonly TriggerPreapprovalView[];
  /** D-402 ruling 5 — the server grants every write of the version from this page (`writes: ["*"]`):
   *  the page offers that. Absent from a server before it, whose page offers each write with its cap. */
  readonly grants_whole_recipe?: true;
}

// ── D-341 slice B3 — a scheduled prompt's writes ───────────────────────────────────────────────

/** The tools whose write has one target, so the tool alone names it (`memory.write`). */
const SINGLE_TARGET_TIER1 = new Set<string>(['recipe.stop', 'memory.write', 'memory.forget', 'episode.record']);

/** What a scheduled prompt's pre-approval names one of its writes by: the AI tool and what it writes
 *  on, as a D-329 write rule names it (`writeRuleScopeOf`): `work.create:task`,
 *  `calendar.create:local`, `contact.write:add`, or the tool alone for one with a single target
 *  (`memory.write`). Undefined for a write no rule names (an unknown tool, a call that says too
 *  little, an id this vocabulary cannot carry) and for saving again a claim the owner revoked,
 *  which asks every time (D-198 §13, as `useWriteRule` refuses it). */
export const triggerPreapprovalTier1Op = (tool: string, args: unknown): string | undefined => {
  if (!isWriteRuleTool(tool)) return undefined;
  if (tool === 'memory.write' && record(args) && typeof args.despite_revoked === 'string') return undefined;
  const scope = writeRuleScopeOf(tool, args);
  if (scope === undefined) return undefined;
  const op = scope === '' ? tool : `${tool}:${scope}`;
  return isId(op) ? op : undefined;
};

/** The tool and scope a scheduled prompt's write is named by, or undefined for a name
 *  `triggerPreapprovalTier1Op` would never make. */
export const readTriggerPreapprovalTier1Op = (op: unknown): { readonly tool: WriteRuleTool; readonly scope: string } | undefined => {
  if (!isId(op)) return undefined;
  const at = op.indexOf(':');
  const tool = at === -1 ? op : op.slice(0, at);
  const scope = at === -1 ? '' : op.slice(at + 1);
  if (!isWriteRuleTool(tool) || SINGLE_TARGET_TIER1.has(tool) !== (scope === '')) return undefined;
  if (tool === 'contact.write' && scope !== 'add' && scope !== 'change') return undefined;
  return { tool, scope };
};

/** D-341 slice B5 (ruling 11) — what a scheduled prompt's pre-approval of its browser actions names:
 *  every Browser Toolkit write its runs make, on any site, as the chat's switch lets them through
 *  (slice A), but standing for the prompt's text. Sites the owner blocked, putting the owner's files
 *  into a page and sign-in codes still ask. */
export const TRIGGER_PREAPPROVAL_BROWSER_OP = 'browser:any_site';

/** How many browser actions one run of it may make without asking: a job (a sign-in, a form) takes
 *  many, so not once a run, as an ask's grant of one write is. */
export const TRIGGER_PREAPPROVAL_BROWSER_PER_RUN = TRIGGER_PREAPPROVAL_MAX_PER_RUN;

/** Whether a scheduled prompt's pre-approval may name this write: one of its AI's Tier-1 writes, or
 *  its browser actions. */
export const isScheduledPromptWrite = (op: unknown): boolean =>
  op === TRIGGER_PREAPPROVAL_BROWSER_OP || readTriggerPreapprovalTier1Op(op) !== undefined;

/** A scheduled prompt's write in the owner's words: "Add a task", "Add a calendar event, for your
 *  Recued calendar", "Act in your browser, on any site"; its name when it is none. */
export const describeTriggerPreapprovalTier1Op = (op: string): string => {
  if (op === TRIGGER_PREAPPROVAL_BROWSER_OP) return 'Act in your browser, on any site';
  const parsed = readTriggerPreapprovalTier1Op(op);
  if (parsed === undefined) return op;
  const { tool, scope } = parsed;
  if (tool === 'work.create' || tool === 'work.update') {
    const [kind, type] = scope.split(':');
    return tier1CallTitle(tool, { kind, ...(type !== undefined ? { type } : {}) }) ?? op;
  }
  const { action, on } = describeWriteRule({ principal: { kind: 'owner_chat' }, tool, scope });
  return on === undefined ? action : `${action}, for ${on}`;
};

/** A scheduled prompt's run, as its own source names it: its schedule, the hash of the prompt text
 *  the run is running (stamped by the scheduler from the occurrence's snapshot), and the run a cap
 *  per run counts in, its occurrence. Undefined for any other source, and for an occurrence queued
 *  before the stamp. ⛔ Not `triggeredRunOf`: a recipe a scheduled prompt's chat starts is that
 *  recipe's run, whose version is not the prompt's. */
export const scheduledPromptRunOf = (source: ExecutionSource | undefined): {
  readonly trigger: Extract<TriggerPreapprovalTrigger, { kind: 'prompt_schedule' }>;
  readonly prompt_sha256: string;
  readonly run_id: string;
} | undefined => {
  if (source?.channel !== 'schedule' || source.actor !== 'system' || source.prompt_schedule === undefined) return undefined;
  const origin = source.prompt_schedule;
  if (!isId(origin.schedule_id) || typeof origin.prompt_sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(origin.prompt_sha256)) {
    return undefined;
  }
  return {
    trigger: { kind: 'prompt_schedule', schedule_id: origin.schedule_id },
    prompt_sha256: origin.prompt_sha256,
    run_id: `prompt:${origin.occurrence_id}`,
  };
};
