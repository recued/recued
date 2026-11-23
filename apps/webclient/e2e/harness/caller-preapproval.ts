/** D-402 slice F4d — UI-only fixture for "what runs without asking" (§7.9) on Contracts, an AI app's
 *  page and a recipe's page: the owner rpcs the panel calls, kept in this tab's sessionStorage. The
 *  server proves what "Stop allowing" ends (`backend/server/src/__tests__/d-402-stop-allowing.test.ts`).
 *  On with `?caller_preapprovals=1`: your chats run "Watch pipeline" (`autorun-live-1`, which
 *  `?recipes=installed` lists) without asking, an "Always" used twice, and "File the water bill" for
 *  one run; Claude Desktop (agreement `k-claude`, listed on Contracts) runs both without asking. An
 *  ended one is listed too, as the server lists it, and shown nowhere. `=fail` refuses the first end;
 *  `=older` is a server from before these, answering both methods `unknown_method`. */
import type { CallerPreapprovalView, PreapprovalCaller } from '@recued/contracts';

const KEY = 'recued-test-caller-preapprovals';
const DAY = 86_400_000;

interface State {
  rows: CallerPreapprovalView[];
  calls: Array<{ method: string; args: unknown }>;
  refused: number;
}

const OWNER: PreapprovalCaller = { kind: 'owner_chat' };
const CLAUDE: PreapprovalCaller = { kind: 'ai_app', contract_id: 'k-claude' };

const initialRows = (): CallerPreapprovalView[] => {
  const at = Date.now() - DAY;
  const base = { recipe_sha256: 'a'.repeat(64), created_at: at, state: 'live' as const };
  return [
    { ...base, id: 'cpa_e2e_1', caller: OWNER, caller_name: 'your chats', recipe_id: 'autorun-live-1', recipe_name: 'Watch pipeline', uses: 2 },
    { ...base, id: 'cpa_e2e_2', caller: OWNER, caller_name: 'your chats', recipe_id: 'file-bill', recipe_name: 'File the water bill',
      uses: 0, run_id: 'run_e2e_1' },
    { ...base, id: 'cpa_e2e_3', caller: CLAUDE, caller_name: 'Claude Desktop', recipe_id: 'autorun-live-1', recipe_name: 'Watch pipeline', uses: 5 },
    { ...base, id: 'cpa_e2e_4', caller: CLAUDE, caller_name: 'Claude Desktop', recipe_id: 'file-bill', recipe_name: 'File the water bill', uses: 1 },
    { ...base, id: 'cpa_e2e_5', caller: CLAUDE, caller_name: 'Claude Desktop', recipe_id: 'old-report', recipe_name: 'Old report', uses: 3,
      state: 'revoked', revoked_at: at + 1 },
  ];
};

/** Claude Desktop's agreement, as `collection.contract.listContracts` lists it. */
const CLAUDE_CONTRACT = {
  contract_id: 'k-claude', minted_at: Date.UTC(2026, 10, 1), minted_by: 'user', display_name: 'Claude Desktop',
  scope: {}, lifecycle_state: 'active',
};

const sameCaller = (a: PreapprovalCaller, b: PreapprovalCaller): boolean =>
  a.kind === 'owner_chat' ? b.kind === 'owner_chat' : b.kind === 'ai_app' && a.contract_id === b.contract_id;

export const callerPreapprovalDemoReply = (
  method: string,
  args: unknown,
): { result?: unknown; error?: { code: string; message: string } } | null => {
  const scenario = new URLSearchParams(location.search).get('caller_preapprovals');
  if (scenario === null) return null;
  if (method === 'collection.contract.listContracts') return { result: { contracts: [CLAUDE_CONTRACT] } };
  if (method !== 'collection.contract.listCallerPreapprovals' && method !== 'collection.contract.stopAllowing') return null;
  const state = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as State | null ?? { rows: initialRows(), calls: [], refused: 0 };
  state.calls.push({ method, args });
  try {
    if (scenario === 'older') return { error: { code: 'unknown_method', message: `${method}: unknown method` } };
    if (method === 'collection.contract.listCallerPreapprovals') return { result: { preapprovals: state.rows } };
    if (scenario === 'fail' && state.refused === 0) {
      state.refused += 1;
      return { error: { code: 'unavailable', message: 'collection.contract.stopAllowing: Recued is busy, try again in a moment' } };
    }
    const input = (args ?? {}) as { caller: PreapprovalCaller; recipe_id: string };
    let preapprovals = 0;
    state.rows = state.rows.map((row) => {
      if (row.state === 'revoked' || row.recipe_id !== input.recipe_id || !sameCaller(row.caller, input.caller)) return row;
      preapprovals += 1;
      return { ...row, state: 'revoked', revoked_at: Date.now() };
    });
    // Its site pass for the bill ends with it, as the server's does.
    return { result: { ended: { preapprovals, site_passes: input.recipe_id === 'file-bill' && preapprovals > 0 ? 1 : 0,
      session_grants: 0, delegations: 0, write_rules: 0 } } };
  } finally {
    sessionStorage.setItem(KEY, JSON.stringify(state));
  }
};

/** D-402 slice F5 — `?caller_preapprovals=1` on a run's page (`?journey=verification#logs/run-verify`): the
 *  run made changes without asking, one under this run's own "Yes" (your chats') and two under Claude
 *  Desktop's "Always" for the water bill, which "Stop allowing" ends from there. */
export const withCallerPreapprovedRun = (method: string, result: unknown): unknown => {
  if (method !== 'execution.get' || new URLSearchParams(location.search).get('caller_preapprovals') === null) return result;
  const run = (result as { run?: Record<string, unknown> | null } | undefined)?.run;
  if (run === undefined || run === null) return result;
  return { ...(result as Record<string, unknown>), run: { ...run, preapproved: [
    { preapproval_id: 'cpa_e2e_2', trigger_kind: 'caller', op: 'recued-core.notes.create', writes: 1, caller: OWNER,
      caller_name: 'your chats', recipe_id: 'file-bill', this_run: true },
    { preapproval_id: 'cpa_e2e_4', trigger_kind: 'caller', op: 'recued-core.notes.create', writes: 2, caller: CLAUDE,
      caller_name: 'Claude Desktop', recipe_id: 'file-bill' },
  ] } };
};
