/** D-321 P2 / C2 — what a step that failed needed and did not have, so the
 *  owner's run surfaces offer the fix instead of ending on the step's error
 *  (`ServerExecuteResponse.run_needs`, the server's `run-needs.ts`).
 *
 *  A run refused before it starts says this in its refusal
 *  (`ConnectionNotSetUpDetails`). A run that starts and stops on a step has
 *  only the step's error, which names neither the pack nor the connection: a
 *  vendor's 401 reads "exa-catalog returned 401 Unauthorized". The server knows
 *  both, from the step's catalog, and names them here.
 *
 *  Only on the owner's own runs: the owner can fix it, and connection names are
 *  owner-surface information (D-320 ruling 12). Never read by a model: the agent
 *  projection drops it (`run-result-agent-projection.ts`), so what chat and MCP
 *  read of a run is unchanged. */

/** A connection a step signed in through, which was not set up or was turned
 *  down. */
export type RunConnectionNeed = {
  kind: 'connection';
  /** The step that failed for it. */
  step_id: string;
  /** `set_up`: the connection the step named is not set up (the gateway's
   *  `no_connection_profile`). `reconnect`: the service did not accept the
   *  sign-in (`OAUTH_EXPIRED`: a 401 or 403, or an OAuth token never acquired). */
  problem: 'set_up' | 'reconnect';
  /** The pack's connection name the step signs in through (D-320). */
  slot: string;
  /** The connection the run used there, when it used one. */
  connection_name?: string;
  /** The pack whose catalog the step called. */
  pack_slug?: string;
  /** The vendor its connection requirement names: which form sets one up. */
  vendor?: string;
  /** What to call the sign-in (`signInLabel`). */
  label?: string;
};

/** A program a step runs, which is missing or would not run as it is. */
export type RunProgramNeed = {
  kind: 'program';
  step_id: string;
  /** The `CliFailureReason` the step stopped on. A program that ran and failed
   *  (`nonzero_exit`, `timeout`, `bad_output`) needs nothing set up, so it is
   *  not a need. */
  problem: 'not_found' | 'broken' | 'untested_version' | 'spawn_error';
  /** The program, as the pack launches it (`rg`). */
  tool?: string;
  /** The pack that runs it. */
  pack_slug?: string;
  /** The pack's name. */
  label?: string;
};

/** D-346 follow-up (2026-11-08) — a program a step runs that is switched off for the owner
 *  (the pack's Access tab, Self (you)), which the run dialog turns on in one click (the
 *  owner's ruling: a "Turn it on" button). Only on the owner's own runs: the gateway carries
 *  `program_switch` only when the refused principal is the owner. */
export type RunSwitchNeed = {
  kind: 'switch';
  step_id: string;
  /** The program's catalog, as `cli.reachability.set` names it (`ingredient_id`). */
  ingredient_id: string;
  /** The operation the step called (its catalog key), as `cli.reachability.set` names it. */
  operation_id: string;
  /** The pack that runs it. */
  pack_slug?: string;
  /** The pack's name. */
  label?: string;
};

export type RunNeed = RunConnectionNeed | RunProgramNeed | RunSwitchNeed;

/** What the catalog gateway attaches to a cli operation it refused because it is switched
 *  off for the owner (`cli_reachability_disabled`), and the engine keeps in the step error's
 *  `details.program_switch`: the switch `cli.reachability.set` turns on. */
export interface ProgramSwitchDetail {
  readonly ingredient_id: string;
  readonly operation_id: string;
}

export const isProgramSwitchDetail = (value: unknown): value is ProgramSwitchDetail =>
  value !== null && typeof value === 'object'
  && typeof (value as { ingredient_id?: unknown }).ingredient_id === 'string'
  && (value as { ingredient_id: string }).ingredient_id.length > 0
  && typeof (value as { operation_id?: unknown }).operation_id === 'string'
  && (value as { operation_id: string }).operation_id.length > 0;

/** The program problems a run need names, in `CliFailureReason` order. */
export const RUN_PROGRAM_NEED_PROBLEMS: readonly RunProgramNeed['problem'][] = [
  'not_found',
  'spawn_error',
  'untested_version',
  'broken',
] as const;
