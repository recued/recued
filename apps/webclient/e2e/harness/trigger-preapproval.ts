/** D-341 slice B2b — UI-only fixture for "What it may do without asking" on a trigger's page: the
 *  owner rpcs it calls, kept in this tab's sessionStorage. The server proves what a trigger offers and
 *  grants (`backend/server/src/__tests__/d-341-trigger-preapproval-choices.test.ts`, the D-341 live
 *  drive). On with `?trigger_preapproval=1`; `=fail-grant` refuses the first grant. Each kind of
 *  trigger runs one recipe here, whatever its id: a webhook the Apple Health intake, a schedule the
 *  daily brief, an event trigger (`trg-e2e-ai`, listed here) a recipe that asks an AI, an auto-run
 *  (`dsh_e2e_timer`, listed here, switched on) its "Watch pipeline", a reception form (B4) the "Book a
 *  table" intake, whose AI triages. A grant has no end date and no use cap (D-341 ruling 10).
 *  `=form` also pairs every form with that intake (its pair page) and records the inbox's approve
 *  calls, beside the `?reception=pending` demo's own answer. `=prompt` (B3) lists one scheduled
 *  prompt, "Morning bills" (`ps_e2e_morning`), which already carries one pre-approval: it may add a
 *  task without asking. A scheduled prompt's changes are learned from their asks, so none is
 *  offered on its card. `=older` is a server from before pre-approvals: it lists the same triggers
 *  and scheduled prompt, and answers each pre-approval method `unknown_method`. `=whole` (D-402
 *  ruling 5) is a server that grants every write of a recipe from the page: its lists say so
 *  (`grants_whole_recipe`), and a grant of `["*"]` covers them all, with no count. */
import type {
  PromptSchedule,
  TriggerPreapprovalChoice,
  TriggerPreapprovalKind,
  TriggerPreapprovalTrigger,
  TriggerPreapprovalView,
} from '@recued/contracts';

const KEY = 'recued-test-trigger-preapproval';
const DAY = 86_400_000;

type Recipe = Omit<TriggerPreapprovalChoice, 'preapprovals'>;
const RECIPES: Readonly<Record<TriggerPreapprovalKind, Recipe>> = {
  webhook: {
    recipe_id: 'receive-body-metrics-apple-health', recipe_name: 'Receive Apple Health readings', ai_steps: [],
    writes: [
      { op: 'recued-core.body-signals.daily_metric.batch',
        label: 'Save up to 100 daily readings in one transaction, all or none', offerable: true },
      { op: 'recued-core.body-signals.daily_metric.delete', label: 'Delete one daily reading', offerable: false,
        reason: 'It deletes or can\'t be undone.' },
    ],
  },
  schedule: {
    recipe_id: 'daily-brief', recipe_name: 'Daily brief', ai_steps: [],
    writes: [
      { op: 'post-note', label: 'Post a note to the team', offerable: true },
      { op: 'recued-core.mail.message.send', label: 'Send an email', offerable: true },
    ],
  },
  event_trigger: {
    recipe_id: 'summarize-inbox', recipe_name: 'Summarize new mail', ai_steps: ['summarize'],
    writes: [{ op: 'post-note', label: 'Post a note to the team', offerable: true }],
  },
  auto_run: {
    recipe_id: 'autorun-live-1', recipe_name: 'Watch pipeline', ai_steps: [],
    writes: [{ op: 'work-entity-task-create', label: 'Add a task', offerable: true }],
  },
  reception: {
    recipe_id: 'intake-book-table', recipe_name: 'Book a table', ai_steps: ['triage'],
    writes: [{ op: 'work-entity-task-create', label: 'Add a task', offerable: true }],
  },
  prompt_schedule: { recipe_id: 'ps_e2e_morning', recipe_name: 'Morning bills', ai_steps: ['prompt'], writes: [] },
};

/** `=prompt`: the scheduled prompt the Automation page lists. */
const PROMPT_SCHEDULE: PromptSchedule = {
  schedule_id: 'ps_e2e_morning', session_id: 'scheduled-e2e-morning', title: 'Morning bills',
  prompt: 'Look through this week\'s bills in my mail and add a task for each one that is due.',
  mode: 'recurring', time_zone: 'Europe/Dublin', cron_expression: '0 7 * * *', enabled: true, revision: 3,
  created_at: Date.UTC(2026, 10, 1), next_run_at: Date.UTC(2026, 10, 9, 7), last_run_at: null, last_turn_id: null,
  last_status: null, notify_on_done: false, model_source_id: null,
};

/** `=prompt`: the pre-approval it already carries. */
const promptPreapproval = (): TriggerPreapprovalView => ({
  id: 'tpa_e2e_prompt', trigger: { kind: 'prompt_schedule', schedule_id: 'ps_e2e_morning' }, recipe_id: 'ps_e2e_morning',
  recipe_sha256: 'b'.repeat(64), writes: ['work.create:task'], max_per_run: 1, uses: 2, created_at: Date.UTC(2026, 10, 2),
  state: 'live', recipe_name: 'Morning bills', ai_steps: ['prompt'], write_labels: ['Add a task'],
  description: 'Morning bills, when it runs on its schedule, may do this without asking: add a task. Its AI decides what it'
    + ' writes. Once a run, until you end it.',
});

/** `=form`: the form's pairing with the intake, as `reception.intake_recipe_pair.get` reads it. */
const formPair = (endpoint_id: string) => ({
  endpoint_id, status: 'ready', pair_subject: 'form',
  binding: { version: 1, recipe_id: 'intake-book-table', recipe_version: 1, pair_revision: 'pr_e2e', form_definition_id: 'form_e2e' },
  claim_configuration_readiness: { status: 'blocked', configuration: null, blockers: ['claim_configuration_missing'] },
  claim_configuration_authoring: { status: 'unavailable' },
  created_at: Date.now() - DAY, updated_at: Date.now() - DAY,
});

interface State {
  rows: TriggerPreapprovalView[];
  calls: Array<{ method: string; args: unknown }>;
  grants_refused: number;
}

const sameTrigger = (a: TriggerPreapprovalTrigger, b: TriggerPreapprovalTrigger): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

export const triggerPreapprovalDemoReply = (method: string, args: unknown): {
  result?: unknown; error?: { code: string; message: string };
} | null => {
  const scenario = new URLSearchParams(location.search).get('trigger_preapproval');
  if (scenario === null) return null;
  const isOwn = method.startsWith('collection.contract.') && /triggerpreapproval/iu.test(method);
  if (scenario === 'form') {
    if (method === 'reception.intake_recipe_pair.get') {
      return { result: formPair(String((args as { endpoint_id?: unknown } | undefined)?.endpoint_id ?? '')) };
    }
    if (method === 'recipe.list') {
      return { result: { recipes: [{ recipe_id: 'intake-book-table', publisher_id: 'local', recipe_hash: 'e2e', source: 'pair-sync',
        installed_at: Date.now() - DAY, version: 1, recipe: { recipe_id: 'intake-book-table', version: 1,
          metadata: { name: 'Book a table', description: 'Takes a table booking from the form.' } } }] } };
    }
    // Recorded only: the `?reception=pending` demo answers it.
    if (method === 'reception.inbox.approve') {
      const kept = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as State | null ?? { rows: [], calls: [], grants_refused: 0 };
      kept.calls.push({ method, args });
      sessionStorage.setItem(KEY, JSON.stringify(kept));
      return null;
    }
  }
  if ((scenario === 'prompt' || scenario === 'older') && method === 'chat.schedules.list') return { result: [PROMPT_SCHEDULE] };
  if (scenario === 'older' && isOwn) {
    const kept = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as State | null ?? { rows: [], calls: [], grants_refused: 0 };
    kept.calls.push({ method, args });
    sessionStorage.setItem(KEY, JSON.stringify(kept));
    return { error: { code: 'unknown_method', message: `${method}: unknown method` } };
  }
  if (!isOwn && method !== 'triggers.list' && method !== 'auto_run.list') return null;
  if (method === 'auto_run.list') {
    return { result: { entries: [{
      recipe_id: 'autorun-live-1', publisher_id: 'recued-core', dish_id: 'dsh_e2e_timer', dish_name: '',
      recipe_name: 'Watch pipeline', interval_ms: 60_000, dynamic: false, enabled: true, auto_disabled: false,
      consecutive_failures: 0, last_failure_at: null, last_failure_reason: null, next_run_at: null,
      last_started_at: null, last_finished_at: null, config_overlay: {}, variables: {},
    }] } };
  }
  if (method === 'triggers.list') {
    return { result: { triggers: [{
      trigger_id: 'trg-e2e-ai', recipe_id: 'summarize-inbox', publisher_id: 'recued-core', pattern: 'data.mail.**',
      enabled: true, created_at: Date.now() - DAY, last_fired_at: null, last_error: null, origin: 'user',
    }] } };
  }
  const state = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as State | null
    ?? { rows: scenario === 'prompt' ? [promptPreapproval()] : [], calls: [], grants_refused: 0 };
  const save = () => sessionStorage.setItem(KEY, JSON.stringify(state));
  state.calls.push({ method, args });
  const input = (args ?? {}) as Record<string, unknown>;
  const trigger = input.trigger as TriggerPreapprovalTrigger | undefined;
  try {
    if (method === 'collection.contract.triggerPreapprovalChoices') {
      if (trigger === undefined) return { error: { code: 'bad_request', message: 'trigger is required' } };
      const recipe = RECIPES[trigger.kind];
      return { result: { recipes: [{ ...recipe, ...(scenario === 'whole' ? { grants_whole_recipe: true } : {}), preapprovals: state.rows
        .filter((row) => sameTrigger(row.trigger, trigger) && row.recipe_id === recipe.recipe_id)
        .sort((a, b) => b.created_at - a.created_at) }] } };
    }
    if (method === 'collection.contract.grantTriggerPreapproval') {
      if (trigger === undefined) return { error: { code: 'bad_request', message: 'trigger is required' } };
      if (scenario === 'fail-grant' && state.grants_refused === 0) {
        state.grants_refused += 1;
        return { error: { code: 'bad_request',
          message: 'collection.contract.grantTriggerPreapproval: Daily brief changed since you opened this' } };
      }
      if (input.max_uses !== undefined || input.ttl_ms !== undefined) {
        return { error: { code: 'bad_request', message: 'collection.contract.grantTriggerPreapproval: a pre-approval has no use cap'
          + ' or end date: it lasts until you end it' } };
      }
      const recipe = RECIPES[trigger.kind];
      const writes = input.writes as string[];
      // D-402 ruling 5 — every write of the recipe, with no count.
      const whole = writes.length === 1 && writes[0] === '*';
      const row: TriggerPreapprovalView = {
        id: `tpa_e2e_${state.rows.length + 1}`, trigger,
        ...(trigger.kind === 'webhook' || trigger.kind === 'reception' ? { door_contract_id: 'door-e2e' } : {}),
        recipe_id: recipe.recipe_id, recipe_sha256: 'a'.repeat(64), writes,
        max_per_run: whole ? 0 : input.max_per_run as number, uses: 0, created_at: Date.now(), state: 'live',
        recipe_name: recipe.recipe_name, ai_steps: recipe.ai_steps,
        write_labels: whole ? recipe.writes.filter((write) => write.offerable).map((write) => write.label)
          : writes.map((op) => recipe.writes.find((write) => write.op === op)?.label ?? op),
        description: `When ${trigger.kind} runs "${recipe.recipe_name}", it may do this without asking.`,
      };
      state.rows.push(row);
      return { result: { preapproval: row } };
    }
    if (method === 'collection.contract.revokeTriggerPreapproval') {
      const row = state.rows.find((candidate) => candidate.id === input.id);
      if (row === undefined) return { error: { code: 'not_found', message: 'no such pre-approval' } };
      Object.assign(row, { state: 'revoked', revoked_at: Date.now() });
      return { result: { preapproval: row } };
    }
    if (method === 'collection.contract.listTriggerPreapprovals') return { result: { preapprovals: state.rows } };
    return null;
  } finally {
    save();
  }
};
